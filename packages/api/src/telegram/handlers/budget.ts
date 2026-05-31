import type { Context } from "grammy";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  BUDGET_CATEGORIES,
  formatBudgetCheckReport,
  formatBudgetEntryReceipt,
  formatBudgetUndoReceipt,
  formatCad,
  formatMonthlyBudgetReport,
  formatWeeklyBudgetReport,
  inferBudgetCategories,
  isBudgetCategoryId,
  logBudgetEntry,
  undoLastBudgetEntry,
  type BudgetCategoryId,
} from "@cherryagent/tools";

interface PendingBudgetAction {
  type: "log" | "check";
  amountCad: number;
  description: string;
  createdAt: number;
}

interface ParsedExpense {
  amountCad: number;
  description: string;
}

const PENDING_PATH = join(
  process.env.HOME ?? ".",
  ".cherryagent",
  "pending-budget.json",
);

function loadPending(): Map<string, PendingBudgetAction> {
  try {
    const raw = readFileSync(PENDING_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const now = Date.now();
    return new Map(
      parsed.filter((entry): entry is [string, PendingBudgetAction] => {
        if (!Array.isArray(entry) || entry.length !== 2) return false;
        const [chatId, pending] = entry;
        if (typeof chatId !== "string") return false;
        if (typeof pending !== "object" || pending == null) return false;
        const record = pending as Record<string, unknown>;
        if (record.type !== "log" && record.type !== "check") return false;
        if (typeof record.amountCad !== "number") return false;
        if (typeof record.description !== "string") return false;
        if (typeof record.createdAt !== "number") return false;
        return now - record.createdAt < 30 * 60 * 1000;
      }),
    );
  } catch {
    return new Map();
  }
}

function savePending(map: Map<string, PendingBudgetAction>): void {
  try {
    mkdirSync(dirname(PENDING_PATH), { recursive: true });
    writeFileSync(PENDING_PATH, JSON.stringify([...map.entries()]), "utf-8");
  } catch {
    // Pending category selection is recoverable; the user can retry the command.
  }
}

function setPending(chatId: string, pending: PendingBudgetAction): void {
  const map = loadPending();
  map.set(chatId, pending);
  savePending(map);
}

function getPending(chatId: string): PendingBudgetAction | undefined {
  return loadPending().get(chatId);
}

function deletePending(chatId: string): void {
  const map = loadPending();
  map.delete(chatId);
  savePending(map);
}

function parseExpenseArgs(args: string): ParsedExpense | null {
  const match = args.trim().match(/^\$?\s*(\d+(?:[.,]\d{1,2})?)\s+(.+)$/);
  if (!match) return null;

  const amountCad = Number(match[1]!.replace(",", "."));
  const description = match[2]!.trim();
  if (!Number.isFinite(amountCad) || amountCad <= 0 || description.length === 0) {
    return null;
  }

  return { amountCad, description };
}

function buildCategoryKeyboard() {
  const rows = [];
  for (let i = 0; i < BUDGET_CATEGORIES.length; i += 2) {
    rows.push(
      BUDGET_CATEGORIES.slice(i, i + 2).map((category) => ({
        text: category.buttonLabel,
        callback_data: `budget_cat_${category.id}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

function formatHelp(): string {
  return [
    "Budget tracker",
    "",
    "/budget - current week dashboard",
    "/budget log 18.42 Starbucks",
    "/budget check 45 Amazon storage bins",
    "/budget month - current month totals",
    "/budget undo - remove last logged expense",
  ].join("\n");
}

function formatCategoryPrompt(
  parsed: ParsedExpense,
  matches: BudgetCategoryId[],
): string {
  const reason =
    matches.length > 0
      ? "This could fit more than one category."
      : "I could not confidently categorize this.";
  return [
    reason,
    "",
    `Choose category for ${formatCad(parsed.amountCad)}:`,
    parsed.description,
  ].join("\n");
}

async function buildActionResult(
  pending: PendingBudgetAction,
  category: BudgetCategoryId,
  timezone?: string,
): Promise<string> {
  if (pending.type === "check") {
    return formatBudgetCheckReport(
      pending.amountCad,
      category,
      pending.description,
      { timezone },
    );
  }

  const entry = await logBudgetEntry({
    amountCad: pending.amountCad,
    category,
    description: pending.description,
    timezone,
  });
  return formatBudgetEntryReceipt(entry);
}

export function createBudgetHandlers() {
  const timezone = process.env.USER_TIMEZONE;

  async function resolveAction(
    ctx: Context,
    type: "log" | "check",
    parsed: ParsedExpense,
  ) {
    const matches = inferBudgetCategories(parsed.description);
    if (matches.length === 1) {
      const result = await buildActionResult(
        {
          type,
          amountCad: parsed.amountCad,
          description: parsed.description,
          createdAt: Date.now(),
        },
        matches[0]!,
        timezone,
      );
      return ctx.reply(result);
    }

    const chatId = String(ctx.chat!.id);
    setPending(chatId, {
      type,
      amountCad: parsed.amountCad,
      description: parsed.description,
      createdAt: Date.now(),
    });

    return ctx.reply(formatCategoryPrompt(parsed, matches), {
      reply_markup: buildCategoryKeyboard(),
    });
  }

  async function handleBudgetCommand(ctx: Context) {
    const args = ((ctx.match as string | undefined) ?? "").trim();

    if (args.length === 0) {
      return ctx.reply(await formatWeeklyBudgetReport({ timezone }));
    }

    if (args === "help") {
      return ctx.reply(formatHelp());
    }

    if (args === "month") {
      return ctx.reply(await formatMonthlyBudgetReport({ timezone }));
    }

    if (args === "undo") {
      const removed = await undoLastBudgetEntry();
      if (!removed) return ctx.reply("No budget entries to undo.");
      return ctx.reply(await formatBudgetUndoReceipt(removed));
    }

    if (args.startsWith("log ")) {
      const parsed = parseExpenseArgs(args.slice(4));
      if (!parsed) return ctx.reply("Usage: /budget log 18.42 Starbucks");
      return resolveAction(ctx, "log", parsed);
    }

    if (args.startsWith("check ")) {
      const parsed = parseExpenseArgs(args.slice(6));
      if (!parsed) return ctx.reply("Usage: /budget check 45 Amazon storage bins");
      return resolveAction(ctx, "check", parsed);
    }

    return ctx.reply(formatHelp());
  }

  async function handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    if (!data.startsWith("budget_cat_")) return false;

    const category = data.replace("budget_cat_", "");
    if (!isBudgetCategoryId(category)) {
      await ctx.answerCallbackQuery({ text: "Unknown budget category." });
      return true;
    }

    const chatId = ctx.chat?.id;
    if (chatId == null) {
      await ctx.answerCallbackQuery();
      return true;
    }

    const pending = getPending(String(chatId));
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "No pending budget action." });
      return true;
    }

    deletePending(String(chatId));
    const result = await buildActionResult(pending, category, timezone);
    await ctx.answerCallbackQuery({
      text: pending.type === "log" ? "Logged." : "Checked.",
    });
    await ctx.editMessageText(result);
    return true;
  }

  return { handleBudgetCommand, handleCallback };
}
