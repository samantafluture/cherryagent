import type { Context } from "grammy";
import {
  GeminiProvider,
  FOOD_PARSE_SYSTEM_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  EXTRACT_LABEL_PROMPT,
  ESTIMATE_FOOD_PROMPT,
} from "@cherryagent/core";
import {
  barcodeLookupTool,
  createFitbitLogFoodTool,
  FitbitAuth,
} from "@cherryagent/tools";
import type { NutritionData, Tool } from "@cherryagent/tools";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── State management (file-backed, survives tsx watch restarts) ───

interface PendingLog {
  nutrition: NutritionData;
  source: "text" | "barcode" | "label_photo" | "food_photo";
  createdAt: number;
}

const PENDING_PATH = join(
  process.env.HOME ?? ".",
  ".cherryagent",
  "pending-food-logs.json",
);

function loadPendingLogs(): Map<string, PendingLog> {
  try {
    const raw = readFileSync(PENDING_PATH, "utf-8");
    const entries = JSON.parse(raw) as [string, PendingLog][];
    // Discard entries older than 10 minutes
    const now = Date.now();
    return new Map(
      entries.filter(([, v]) => now - v.createdAt < 10 * 60 * 1000),
    );
  } catch {
    return new Map();
  }
}

function savePendingLogs(logs: Map<string, PendingLog>): void {
  try {
    mkdirSync(dirname(PENDING_PATH), { recursive: true });
    writeFileSync(PENDING_PATH, JSON.stringify([...logs.entries()]), "utf-8");
  } catch (err) {
    console.error("Failed to save pending logs:", err);
  }
}

function setPending(chatId: string, log: PendingLog): void {
  const logs = loadPendingLogs();
  logs.set(chatId, log);
  savePendingLogs(logs);
}

function getPending(chatId: string): PendingLog | undefined {
  return loadPendingLogs().get(chatId);
}

function deletePending(chatId: string): void {
  const logs = loadPendingLogs();
  logs.delete(chatId);
  savePendingLogs(logs);
}

// ─── Factory ───

interface FoodLogDeps {
  gemini: GeminiProvider;
  fitbitAuth: FitbitAuth;
  botToken: string;
}

export function createFoodLogHandlers(deps: FoodLogDeps) {
  const { gemini, fitbitAuth, botToken } = deps;
  const fitbitLogTool = createFitbitLogFoodTool(fitbitAuth);

  // ─── FLOW 1: Text input ───

  async function handleText(ctx: Context) {
    const text = ctx.message?.text;
    if (!text) return;

    // Skip bot commands
    if (text.startsWith("/")) return;

    console.log(`[food-log] Text received: "${text}"`);

    // Check if it's a barcode number (8 or 13 digits)
    if (/^\d{8,13}$/.test(text.trim())) {
      return handleBarcode(ctx, text.trim());
    }

    // Natural language food description
    await ctx.reply("Parsing...");

    const response = await gemini.chat({
      systemInstruction: FOOD_PARSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      jsonMode: true,
    });

    if (!response.content) {
      return ctx.reply(
        "Couldn't parse that as food. Try: '2 eggs and toast for breakfast'",
      );
    }

    let nutrition: NutritionData;
    try {
      nutrition = JSON.parse(response.content) as NutritionData;
    } catch {
      return ctx.reply(
        "Couldn't parse that as food. Try: '2 eggs and toast for breakfast'",
      );
    }

    if (!nutrition.foodName || !nutrition.calories) {
      return ctx.reply(
        "Couldn't identify the food. Try being more specific, e.g. '150g grilled chicken breast'",
      );
    }

    return showConfirmation(ctx, nutrition, "text");
  }

  // ─── FLOW 2: Barcode ───

  async function handleBarcode(ctx: Context, barcode: string) {
    await ctx.reply(`Looking up barcode ${barcode}...`);

    const result = await barcodeLookupTool.execute(
      { barcode },
      { taskId: "telegram", permissions: [] },
    );

    if (!result.success) {
      return ctx.reply(
        `Product not found for barcode ${barcode}. Try sending a photo of the nutrition label instead.`,
      );
    }

    const nutrition = JSON.parse(result.output) as NutritionData;
    return showConfirmation(ctx, nutrition, "barcode");
  }

  // ─── FLOW 3: Photo (label, food, or barcode photo) ───

  async function handlePhoto(ctx: Context) {
    const photo = ctx.message?.photo;
    if (!photo?.length) return;

    await ctx.reply("Analyzing photo...");

    // Get highest resolution version
    const largest = photo[photo.length - 1]!;
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) {
      return ctx.reply("Couldn't download the photo. Try again?");
    }

    // Download photo from Telegram
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const imageResponse = await fetch(url);
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(imageBuffer).toString("base64");

    // Step 1: Classify the image
    const classifyResponse = await gemini.chatWithImage({
      prompt: CLASSIFY_IMAGE_PROMPT,
      imageBase64: base64,
      mimeType: "image/jpeg",
      jsonMode: true,
    });

    let classification: { type?: string };
    try {
      classification = JSON.parse(classifyResponse.content ?? "{}") as {
        type?: string;
      };
    } catch {
      classification = {};
    }

    switch (classification.type) {
      case "barcode": {
        // Extract barcode number from image, then look up
        const barcodeResponse = await gemini.chatWithImage({
          prompt:
            "Extract the barcode number from this image. Return ONLY the digits, nothing else.",
          imageBase64: base64,
          mimeType: "image/jpeg",
        });
        const barcodeNumber = barcodeResponse.content
          ?.trim()
          .replace(/\D/g, "");
        if (barcodeNumber && /^\d{8,13}$/.test(barcodeNumber)) {
          return handleBarcode(ctx, barcodeNumber);
        }
        return ctx.reply(
          "Couldn't read the barcode clearly. Try typing the number manually.",
        );
      }

      case "nutrition_label": {
        // Extract macros directly from label
        const labelResponse = await gemini.chatWithImage({
          prompt: EXTRACT_LABEL_PROMPT,
          imageBase64: base64,
          mimeType: "image/jpeg",
          jsonMode: true,
        });
        let labelNutrition: NutritionData;
        try {
          labelNutrition = JSON.parse(
            labelResponse.content ?? "{}",
          ) as NutritionData;
        } catch {
          return ctx.reply(
            "Couldn't read the nutrition label. Try a clearer photo.",
          );
        }
        return showConfirmation(ctx, labelNutrition, "label_photo");
      }

      case "food": {
        // Estimate nutrition from food photo
        const foodResponse = await gemini.chatWithImage({
          prompt: ESTIMATE_FOOD_PROMPT,
          imageBase64: base64,
          mimeType: "image/jpeg",
          jsonMode: true,
        });
        let foodNutrition: NutritionData;
        try {
          foodNutrition = JSON.parse(
            foodResponse.content ?? "{}",
          ) as NutritionData;
        } catch {
          return ctx.reply(
            "Couldn't estimate nutrition from this photo. Try a different angle.",
          );
        }
        return showConfirmation(ctx, foodNutrition, "food_photo");
      }

      default:
        return ctx.reply(
          "Couldn't identify this as a food photo, nutrition label, or barcode. Try again?",
        );
    }
  }

  // ─── Confirmation Flow (shared by all inputs) ───

  function showConfirmation(
    ctx: Context,
    nutrition: NutritionData,
    source: PendingLog["source"],
  ) {
    const chatId = String(ctx.chat!.id);

    setPending(chatId, {
      nutrition,
      source,
      createdAt: Date.now(),
    });

    const msg = formatNutritionSummary(nutrition, source);

    return ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Log it", callback_data: "food_confirm" },
            { text: "Cancel", callback_data: "food_cancel" },
          ],
          [
            { text: "Breakfast", callback_data: "meal_Breakfast" },
            { text: "Lunch", callback_data: "meal_Lunch" },
            { text: "Dinner", callback_data: "meal_Dinner" },
            { text: "Snack", callback_data: "meal_Anytime" },
          ],
        ],
      },
    });
  }

  // ─── Callback Handler ───

  async function handleCallback(ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    console.log(`[food-log] Callback: ${data} from chat ${chatId}`);

    const pending = getPending(chatId);
    console.log(`[food-log] Pending log found: ${!!pending}`);

    if (!pending) {
      return ctx.answerCallbackQuery({ text: "No pending food log." });
    }

    if (data === "food_cancel") {
      deletePending(chatId);
      await ctx.answerCallbackQuery({ text: "Cancelled." });
      return ctx.editMessageText("Cancelled.");
    }

    // Determine meal type
    const VALID_MEALS = new Set([
      "Breakfast",
      "Morning Snack",
      "Lunch",
      "Afternoon Snack",
      "Dinner",
      "Anytime",
    ]);
    let mealType: NutritionData["mealType"] =
      pending.nutrition.mealType ?? "Anytime";

    if (data.startsWith("meal_")) {
      const parsed = data.replace("meal_", "");
      if (VALID_MEALS.has(parsed)) {
        mealType = parsed as NutritionData["mealType"];
      }
    }
    // "food_confirm" uses the existing mealType (from LLM parse or default)

    // Log to Fitbit
    console.log(`[food-log] Logging to Fitbit: ${pending.nutrition.foodName} (${pending.nutrition.calories} cal) as ${mealType}`);
    const result = await fitbitLogTool.execute(
      {
        foodName: pending.nutrition.foodName,
        calories: pending.nutrition.calories,
        protein: pending.nutrition.protein ?? 0,
        carbs: pending.nutrition.carbs ?? 0,
        fat: pending.nutrition.fat ?? 0,
        mealType,
      },
      { taskId: "telegram", permissions: [] },
    );

    console.log(`[food-log] Fitbit result: success=${result.success} output=${result.output}`);
    deletePending(chatId);

    if (result.success) {
      await ctx.answerCallbackQuery({ text: "Logged!" });
      return ctx.editMessageText(`Logged: ${result.output}`);
    } else {
      await ctx.answerCallbackQuery({ text: "Failed" });
      return ctx.editMessageText(`Failed: ${result.output}`);
    }
  }

  return { handleText, handlePhoto, handleCallback };
}

// ─── Helpers ───

function formatNutritionSummary(
  n: NutritionData,
  source: PendingLog["source"],
): string {
  const sourceLabel: Record<string, string> = {
    text: "[text]",
    barcode: "[barcode]",
    label_photo: "[label]",
    food_photo: "[photo]",
  };

  const lines = [
    `${sourceLabel[source] ?? ""} <b>${n.foodName}</b>${n.brand ? ` (${n.brand})` : ""}`,
    "",
    `${n.calories} cal`,
    `${n.protein ?? 0}g protein | ${n.carbs ?? 0}g carbs | ${n.fat ?? 0}g fat`,
  ];

  if (n.servingSize) {
    lines.push(`Serving: ${n.servingSize}`);
  }
  if (n.confidence && n.confidence !== "high") {
    lines.push(`Confidence: ${n.confidence}`);
  }
  if (n.items?.length) {
    lines.push("", "Items: " + n.items.join(", "));
  }
  if (n.notes) {
    lines.push(`Note: ${n.notes}`);
  }
  if (n.mealType) {
    lines.push(`Meal: ${n.mealType}`);
  }

  lines.push("", "Tap a meal type, or Log it to use the default:");

  return lines.join("\n");
}
