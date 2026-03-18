import type { Context } from "grammy";
import {
  logSpoon,
  getSpoonForRange,
} from "@cherryagent/tools";
import { formatSpoonReport } from "@cherryagent/tools";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Pending state (file-backed, survives tsx watch restarts) ───

interface PendingSpoon {
  type: "morning" | "evening";
  createdAt: number;
}

const PENDING_PATH = join(
  process.env.HOME ?? ".",
  ".cherryagent",
  "pending-spoon.json",
);

function loadPending(): Map<string, PendingSpoon> {
  try {
    const raw = readFileSync(PENDING_PATH, "utf-8");
    const entries = JSON.parse(raw) as [string, PendingSpoon][];
    const now = Date.now();
    // Discard entries older than 30 minutes
    return new Map(
      entries.filter(([, v]) => now - v.createdAt < 30 * 60 * 1000),
    );
  } catch {
    return new Map();
  }
}

function savePending(map: Map<string, PendingSpoon>): void {
  try {
    mkdirSync(dirname(PENDING_PATH), { recursive: true });
    writeFileSync(PENDING_PATH, JSON.stringify([...map.entries()]), "utf-8");
  } catch (err) {
    console.error("Failed to save pending spoon:", err);
  }
}

function setPending(chatId: string, pending: PendingSpoon): void {
  const map = loadPending();
  map.set(chatId, pending);
  savePending(map);
}

function getPending(chatId: string): PendingSpoon | undefined {
  return loadPending().get(chatId);
}

function deletePending(chatId: string): void {
  const map = loadPending();
  map.delete(chatId);
  savePending(map);
}

// ─── Questions ───

const MORNING_QUESTIONS = [
  "1️⃣ Energy level right now? (1-5)",
  "2️⃣ What's going to cost energy today?",
  "3️⃣ What do you need to protect today?",
].join("\n");

const EVENING_QUESTIONS = [
  "1️⃣ Energy level right now? (1-5)",
  "2️⃣ What cost the most energy today?",
  "3️⃣ What restored energy today?",
  "4️⃣ Any masking events? (or skip)",
].join("\n");

// ─── Spoon bar emoji ───

function spoonEmoji(level: number): string {
  return "🥄".repeat(level) + "  ".repeat(5 - level);
}

// ─── Helpers ───

function todayDate(timezone?: string): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: timezone ?? "America/Toronto",
  });
}

// ─── Factory ───

export function createSpoonHandlers() {
  const timezone = process.env.USER_TIMEZONE;

  async function handleSpoonCommand(ctx: Context) {
    const args = ((ctx.match as string | undefined) ?? "").trim();

    if (args === "morning") {
      return startCheckin(ctx, "morning");
    }
    if (args === "evening") {
      return startCheckin(ctx, "evening");
    }
    if (args.startsWith("report")) {
      const daysArg = args.replace("report", "").trim();
      const days = Number(daysArg) || 7;
      return showReport(ctx, days);
    }

    return ctx.reply(
      "🥄 <b>Spoon Tracker</b>\n\n" +
        "/spoon morning — morning check-in\n" +
        "/spoon evening — evening check-in\n" +
        "/spoon report [days] — energy report (default 7)",
      { parse_mode: "HTML" },
    );
  }

  async function startCheckin(ctx: Context, type: "morning" | "evening") {
    const chatId = String(ctx.chat!.id);
    const questions =
      type === "morning" ? MORNING_QUESTIONS : EVENING_QUESTIONS;

    await ctx.reply(
      `🥄 <b>${type === "morning" ? "Morning" : "Evening"} Check-in</b>\n\n${questions}\n\n<i>Reply with all answers (one per line):</i>`,
      { parse_mode: "HTML" },
    );

    setPending(chatId, { type, createdAt: Date.now() });
  }

  async function handleText(ctx: Context): Promise<boolean> {
    const chatId = String(ctx.chat!.id);
    const pending = getPending(chatId);
    if (!pending) return false;

    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) return false;

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Extract spoon level from first line
    const levelMatch = lines[0]?.match(/(\d)/);
    let spoonLevel: number | undefined;

    if (levelMatch) {
      spoonLevel = Math.max(1, Math.min(5, Number(levelMatch[1])));
    }

    // If no number found, show inline keyboard
    if (spoonLevel == null) {
      const buttons = [1, 2, 3, 4, 5].map((n) => ({
        text: String(n),
        callback_data: `spoon_level_${n}_${pending.type}_${encodeURIComponent(text)}`,
      }));
      await ctx.reply("What's your energy level? (1-5)", {
        reply_markup: { inline_keyboard: [buttons] },
      });
      return true;
    }

    // Parse remaining lines
    const restLines = lines.slice(1);
    await storeEntry(ctx, pending.type, spoonLevel, restLines);
    deletePending(chatId);
    return true;
  }

  async function storeEntry(
    ctx: Context,
    type: "morning" | "evening",
    spoonLevel: number,
    answerLines: string[],
  ) {
    const date = todayDate(timezone);

    if (type === "morning") {
      await logSpoon({
        date,
        type,
        timestamp: Date.now(),
        spoonLevel,
        energyCosts: answerLines[0] || undefined,
        protect: answerLines[1] || undefined,
      });
    } else {
      await logSpoon({
        date,
        type,
        timestamp: Date.now(),
        spoonLevel,
        energyCosts: answerLines[0] || undefined,
        restored: answerLines[1] || undefined,
        maskEvents: answerLines[2] || undefined,
      });
    }

    await ctx.reply(
      `✅ ${type === "morning" ? "Morning" : "Evening"} logged!\n${spoonEmoji(spoonLevel)} ${spoonLevel}/5`,
    );
  }

  async function handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    if (!data.startsWith("spoon_")) return false;

    // spoon_level_N_type_encodedText
    const match = data.match(/^spoon_level_(\d)_(morning|evening)_(.*)$/);
    if (!match) return false;

    const spoonLevel = Number(match[1]);
    const type = match[2] as "morning" | "evening";
    const text = decodeURIComponent(match[3]!);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const chatId = String(ctx.chat!.id);
    deletePending(chatId);

    await ctx.answerCallbackQuery();
    await storeEntry(ctx, type, spoonLevel, lines);
    return true;
  }

  async function showReport(ctx: Context, days: number) {
    const now = new Date();
    const endDate = todayDate(timezone);
    const startD = new Date(now);
    startD.setDate(startD.getDate() - (days - 1));
    const startDate = startD.toLocaleDateString("en-CA", {
      timeZone: timezone ?? "America/Toronto",
    });

    const entries = await getSpoonForRange(startDate, endDate);
    const report = formatSpoonReport(entries, days);
    await ctx.reply(report);
  }

  return { handleSpoonCommand, handleText, handleCallback };
}
