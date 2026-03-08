import type { Context } from "grammy";
import {
  GeminiProvider,
  FOOD_PARSE_SYSTEM_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  EXTRACT_LABEL_PROMPT,
  ESTIMATE_FOOD_PROMPT,
  CORRECT_FOOD_PROMPT,
} from "@cherryagent/core";
import {
  barcodeLookupTool,
  createFitbitLogFoodTool,
  FitbitAuth,
  addFoodFavorite,
  listFoodFavorites,
  getFoodFavoriteByIndex,
  removeFoodFavoriteByIndex,
  trackSaturatedFat,
  logCost,
  checkSpendWarning,
} from "@cherryagent/tools";
import type { NutritionData } from "@cherryagent/tools";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Constants ───

const PORTION_OPTIONS = [1/6, 0.25, 0.5, 1, 1.5, 2, 3];

const PORTION_LABELS: Record<number, string> = {
  [1/6]: "1/6x",
  0.25: "1/4x",
  0.5: "1/2x",
  1: "1x",
  1.5: "1.5x",
  2: "2x",
  3: "3x",
};

// ─── State management (file-backed, survives tsx watch restarts) ───

interface PendingLog {
  nutrition: NutritionData;
  source: "text" | "barcode" | "label_photo" | "food_photo";
  portion: number;
  selectedMeal?: string;
  confirmationMessageId?: number;
  waitingForName?: boolean;
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
  const log = loadPendingLogs().get(chatId);
  if (log && log.portion == null) log.portion = 1; // backward compat
  return log;
}

function deletePending(chatId: string): void {
  const logs = loadPendingLogs();
  logs.delete(chatId);
  savePendingLogs(logs);
}

// ─── Helpers ───

function scaleNutrition(base: NutritionData, portion: number): NutritionData {
  return {
    ...base,
    calories: Math.round(base.calories * portion),
    protein: base.protein != null ? Math.round(base.protein * portion) : undefined,
    carbs: base.carbs != null ? Math.round(base.carbs * portion) : undefined,
    fat: base.fat != null ? Math.round(base.fat * portion) : undefined,
    saturatedFat: base.saturatedFat != null ? Math.round(base.saturatedFat * portion) : undefined,
  };
}

function buildConfirmationKeyboard(
  portion: number,
  selectedMeal?: string,
) {
  const portionRow = PORTION_OPTIONS.map((p) => ({
    text: p === portion ? `• ${PORTION_LABELS[p]} •` : PORTION_LABELS[p]!,
    callback_data: `portion_${p}`,
  }));

  const meals = [
    { label: "Breakfast", value: "Breakfast" },
    { label: "Lunch", value: "Lunch" },
    { label: "Dinner", value: "Dinner" },
    { label: "Snack", value: "Anytime" },
  ];
  const mealRow = meals.map((m) => ({
    text: m.value === selectedMeal ? `• ${m.label} •` : m.label,
    callback_data: `meal_${m.value}`,
  }));

  const actionRow = [
    { text: "Edit name", callback_data: "edit_name" },
    { text: "Save", callback_data: "food_save" },
    { text: "Log it", callback_data: "food_confirm" },
    { text: "Cancel", callback_data: "food_cancel" },
  ];

  return { inline_keyboard: [portionRow, mealRow, actionRow] };
}

// ─── Factory ───

interface FoodLogDeps {
  gemini: GeminiProvider;
  fitbitAuth: FitbitAuth;
  botToken: string;
  costConfig?: { timezone?: string; dailyCapUsd?: number; monthlyCapUsd?: number };
}

export function createFoodLogHandlers(deps: FoodLogDeps) {
  const { gemini, fitbitAuth, botToken } = deps;

  async function trackGeminiCost(
    usage: { inputTokens: number; outputTokens: number },
    detail: string,
    ctx: Context,
  ) {
    const cost =
      (usage.inputTokens / 1_000_000) * gemini.inputCostPer1M +
      (usage.outputTokens / 1_000_000) * gemini.outputCostPer1M;
    if (cost > 0) {
      await logCost("food", "gemini", cost, detail, deps.costConfig?.timezone);
      const warning = await checkSpendWarning(deps.costConfig);
      if (warning) await ctx.reply(warning);
    }
  }
  const fitbitLogTool = createFitbitLogFoodTool(
    fitbitAuth,
    process.env.USER_TIMEZONE,
  );

  // ─── FLOW 1: Text input ───

  async function handleText(ctx: Context) {
    const text = ctx.message?.text;
    if (!text) return;

    // Skip bot commands
    if (text.startsWith("/")) return;

    console.log(`[food-log] Text received: "${text}"`);

    // Check if we're waiting for a name edit
    const chatId = String(ctx.chat!.id);
    const pending = getPending(chatId);
    if (pending?.waitingForName) {
      return handleNameEdit(ctx, pending, text);
    }

    // Check if this is a reply to a confirmation message (correction flow)
    const replyTo = ctx.message.reply_to_message;
    if (replyTo) {
      if (pending?.confirmationMessageId === replyTo.message_id) {
        return handleCorrection(ctx, pending, text);
      }
    }

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
    await trackGeminiCost(response.usage, "food parse", ctx);

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

    if (!nutrition.calories) {
      return ctx.reply(
        "Couldn't identify the food. Try being more specific, e.g. '150g grilled chicken breast'",
      );
    }

    if (!nutrition.foodName) nutrition.foodName = "Unknown food";

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
    await trackGeminiCost(classifyResponse.usage, "image classify", ctx);

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
        await trackGeminiCost(barcodeResponse.usage, "barcode read", ctx);
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
        await trackGeminiCost(labelResponse.usage, "label extract", ctx);
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
        await trackGeminiCost(foodResponse.usage, "food estimate", ctx);
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

  async function showConfirmation(
    ctx: Context,
    nutrition: NutritionData,
    source: PendingLog["source"],
  ) {
    const chatId = String(ctx.chat!.id);
    const msg = formatNutritionSummary(nutrition, source, 1);

    const sent = await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: buildConfirmationKeyboard(1),
    });

    setPending(chatId, {
      nutrition,
      source,
      portion: 1,
      confirmationMessageId: sent.message_id,
      createdAt: Date.now(),
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

    // ── Edit name ──
    if (data === "edit_name") {
      pending.waitingForName = true;
      setPending(chatId, pending);
      await ctx.answerCallbackQuery();
      return ctx.reply("Send the new name for this food:");
    }

    // ── Save as favorite ──
    if (data === "food_save") {
      const { alreadyExisted } = await addFoodFavorite(pending.nutrition);
      return ctx.answerCallbackQuery({
        text: alreadyExisted ? "Already saved!" : "Saved!",
      });
    }

    // ── Portion selection ──
    if (data.startsWith("portion_")) {
      const newPortion = Number(data.replace("portion_", ""));
      if (newPortion === pending.portion) {
        return ctx.answerCallbackQuery(); // no-op, same portion
      }
      pending.portion = newPortion;
      setPending(chatId, pending);

      const scaled = scaleNutrition(pending.nutrition, newPortion);
      const msg = formatNutritionSummary(scaled, pending.source, newPortion);
      await ctx.editMessageText(msg, {
        parse_mode: "HTML",
        reply_markup: buildConfirmationKeyboard(newPortion, pending.selectedMeal),
      });
      return ctx.answerCallbackQuery();
    }

    // ── Meal selection (no logging) ──
    if (data.startsWith("meal_")) {
      const VALID_MEALS = new Set([
        "Breakfast",
        "Morning Snack",
        "Lunch",
        "Afternoon Snack",
        "Dinner",
        "Anytime",
      ]);
      const parsed = data.replace("meal_", "");
      if (!VALID_MEALS.has(parsed)) {
        return ctx.answerCallbackQuery();
      }
      pending.selectedMeal = parsed;
      setPending(chatId, pending);

      await ctx.editMessageReplyMarkup({
        reply_markup: buildConfirmationKeyboard(pending.portion, parsed),
      });
      return ctx.answerCallbackQuery({ text: parsed === "Anytime" ? "Snack" : parsed });
    }

    // ── Confirm: log to Fitbit ──
    const mealType = (pending.selectedMeal ?? pending.nutrition.mealType ?? "Anytime") as NutritionData["mealType"];
    const scaled = scaleNutrition(pending.nutrition, pending.portion);

    console.log(`[food-log] Logging to Fitbit: ${scaled.foodName} (${scaled.calories} cal, ${pending.portion}x) as ${mealType}`);
    const result = await fitbitLogTool.execute(
      {
        foodName: scaled.foodName,
        calories: scaled.calories,
        protein: scaled.protein ?? 0,
        carbs: scaled.carbs ?? 0,
        fat: scaled.fat ?? 0,
        saturatedFat: scaled.saturatedFat,
        mealType,
      },
      { taskId: "telegram", permissions: [] },
    );

    console.log(`[food-log] Fitbit result: success=${result.success} output=${result.output}`);
    deletePending(chatId);

    if (result.success) {
      // Track saturated fat locally (Fitbit API doesn't return it in daily summary)
      if (scaled.saturatedFat != null && scaled.saturatedFat > 0) {
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: process.env.USER_TIMEZONE ?? "America/Toronto",
        });
        await trackSaturatedFat(today, scaled.foodName, scaled.saturatedFat);
      }
      await ctx.answerCallbackQuery({ text: "Logged!" });
      return ctx.editMessageText(`Logged: ${result.output}`);
    } else {
      await ctx.answerCallbackQuery({ text: "Failed" });
      return ctx.editMessageText(`Failed: ${result.output}`);
    }
  }

  // ─── Correction Flow (reply-to-correct) ───

  async function handleCorrection(
    ctx: Context,
    pending: PendingLog,
    correctionText: string,
  ) {
    const chatId = String(ctx.chat!.id);

    await ctx.reply("Updating...");

    const response = await gemini.chat({
      systemInstruction: CORRECT_FOOD_PROMPT,
      messages: [
        {
          role: "user",
          content: `Original nutrition data:\n${JSON.stringify(pending.nutrition, null, 2)}\n\nCorrection: ${correctionText}`,
        },
      ],
      jsonMode: true,
    });
    await trackGeminiCost(response.usage, "food correction", ctx);

    if (!response.content) {
      return ctx.reply("Couldn't process the correction. Try again?");
    }

    let corrected: NutritionData;
    try {
      corrected = JSON.parse(response.content) as NutritionData;
    } catch {
      return ctx.reply("Couldn't parse the correction. Try again?");
    }

    if (!corrected.calories) {
      return ctx.reply("Couldn't apply the correction. Try being more specific.");
    }

    if (!corrected.foodName) corrected.foodName = "Unknown food";

    // Update pending: replace nutrition, reset portion (base values changed)
    pending.nutrition = corrected;
    pending.portion = 1;
    setPending(chatId, pending);

    const msg = formatNutritionSummary(corrected, pending.source, 1);

    await ctx.api.editMessageText(
      chatId,
      pending.confirmationMessageId!,
      msg,
      {
        parse_mode: "HTML",
        reply_markup: buildConfirmationKeyboard(1, pending.selectedMeal),
      },
    );
  }

  async function handleNameEdit(
    ctx: Context,
    pending: PendingLog,
    newName: string,
  ) {
    const chatId = String(ctx.chat!.id);
    pending.nutrition.foodName = newName.trim();
    pending.waitingForName = false;
    setPending(chatId, pending);

    const scaled = scaleNutrition(pending.nutrition, pending.portion);
    const msg = formatNutritionSummary(scaled, pending.source, pending.portion);

    await ctx.api.editMessageText(
      chatId,
      pending.confirmationMessageId!,
      msg,
      {
        parse_mode: "HTML",
        reply_markup: buildConfirmationKeyboard(pending.portion, pending.selectedMeal),
      },
    );
  }

  // ─── /food help command ───

  async function handleFoodCommand(ctx: Context) {
    return ctx.reply(
      "<b>Food Logger</b>\n\n" +
      "<b>Log food:</b>\n" +
      "  Text — type a description (e.g. \"2 eggs and toast\")\n" +
      "  Photo — send a photo of food, label, or barcode\n" +
      "  Barcode — type 8-13 digit barcode number\n\n" +
      "<b>Favorites:</b>\n" +
      "  /fav — list saved foods\n" +
      "  /fav &lt;#&gt; — log a saved food\n" +
      "  /fav rm &lt;#&gt; — remove a saved food\n\n" +
      "<b>Reports:</b>\n" +
      "  /report — saturated fat report (today + weekly)",
      { parse_mode: "HTML" },
    );
  }

  // ─── /fav command ───

  async function handleFavCommand(ctx: Context) {
    const args = ((ctx.match as string | undefined) ?? "").trim();

    // /fav rm <n>
    if (args.startsWith("rm ")) {
      const index = Number(args.replace("rm ", "").trim());
      if (!index || index < 1) {
        return ctx.reply("Usage: /fav rm <number>");
      }
      const removed = await removeFoodFavoriteByIndex(index);
      if (!removed) {
        return ctx.reply(`No favorite at #${index}.`);
      }
      return ctx.reply(`Removed: ${removed.nutrition.foodName}`);
    }

    // /fav <n> — log a favorite
    if (/^\d+$/.test(args)) {
      const index = Number(args);
      const fav = await getFoodFavoriteByIndex(index);
      if (!fav) {
        return ctx.reply(`No favorite at #${index}.`);
      }
      return showConfirmation(ctx, fav.nutrition, "text");
    }

    // /fav — list all
    const favorites = await listFoodFavorites();
    if (favorites.length === 0) {
      return ctx.reply("No saved foods yet. Log a food and tap Save to add one.");
    }

    const lines = ["<b>Saved foods:</b>", ""];
    for (let i = 0; i < favorites.length; i++) {
      const f = favorites[i]!;
      lines.push(`${i + 1}. ${f.nutrition.foodName} (${f.nutrition.calories} cal)`);
    }
    lines.push("", "Use /fav &lt;#&gt; to log one.");
    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  return { handleText, handlePhoto, handleCallback, handleFavCommand, handleFoodCommand };
}

function formatNutritionSummary(
  n: NutritionData,
  source: PendingLog["source"],
  portion: number,
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
    `${n.protein ?? 0}g protein | ${n.carbs ?? 0}g carbs | ${n.fat ?? 0}g fat${n.saturatedFat != null ? ` (${n.saturatedFat}g sat)` : ""}`,
  ];

  if (portion !== 1) {
    lines.push(`Portion: ${PORTION_LABELS[portion] ?? `${portion}x`}`);
  }
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

  lines.push("", "Select portion and meal, then tap Log it:");

  return lines.join("\n");
}
