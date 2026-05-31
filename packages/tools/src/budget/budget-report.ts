import {
  BUDGET_CATEGORIES,
  formatCad,
  getBudgetCategory,
  getMonthlyVariableGoalCad,
  getWeeklyGoalCad,
  getWeeklyVariableGoalCad,
  type BudgetCategory,
  type BudgetCategoryId,
} from "./categories.js";
import type { BudgetEntry } from "./budget-tracker.js";
import {
  formatShortDate,
  getDateInTimezone,
  getDaysElapsedInWeek,
  getDaysRemainingInWeek,
  getMonthPrefix,
  getWeekEndForDate,
  getWeekStartForDate,
} from "./date.js";
import {
  getCurrentMonthBudgetEntries,
  getCurrentWeekBudgetEntries,
  getBudgetEntriesForWeek,
} from "./budget-tracker.js";

interface BudgetReportOptions {
  timezone?: string;
  now?: Date;
}

interface CategoryStatus {
  category: BudgetCategory;
  spentCad: number;
  goalCad: number;
  remainingCad: number;
}

function pluralizeDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

function getTotalsByCategory(entries: BudgetEntry[]): Map<BudgetCategoryId, number> {
  const totals = new Map<BudgetCategoryId, number>();
  for (const entry of entries) {
    totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.amountCad);
  }
  return totals;
}

function getWeeklyStatuses(entries: BudgetEntry[]): CategoryStatus[] {
  const totals = getTotalsByCategory(entries);
  return BUDGET_CATEGORIES.map((category) => {
    const spentCad = totals.get(category.id) ?? 0;
    const goalCad = getWeeklyGoalCad(category);
    return {
      category,
      spentCad,
      goalCad,
      remainingCad: goalCad - spentCad,
    };
  });
}

function getMonthlyStatuses(entries: BudgetEntry[]): CategoryStatus[] {
  const totals = getTotalsByCategory(entries);
  return BUDGET_CATEGORIES.map((category) => {
    const spentCad = totals.get(category.id) ?? 0;
    return {
      category,
      spentCad,
      goalCad: category.monthlyGoalCad,
      remainingCad: category.monthlyGoalCad - spentCad,
    };
  });
}

function formatStatusLine(status: CategoryStatus): string {
  const over = status.remainingCad < 0 ? ` OVER by ${formatCad(Math.abs(status.remainingCad))}` : "";
  return `${status.category.label}: ${formatCad(status.spentCad)} / ${formatCad(status.goalCad)}${over}`;
}

function getWeekWarnings(
  statuses: CategoryStatus[],
  today: string,
): string[] {
  const daysElapsed = getDaysElapsedInWeek(today);
  const daysRemaining = getDaysRemainingInWeek(today);
  const overWarnings: string[] = [];
  const paceWarnings: string[] = [];

  for (const status of statuses) {
    if (status.spentCad <= 0) continue;

    if (status.spentCad > status.goalCad) {
      overWarnings.push(
        `${status.category.label} is ${formatCad(status.spentCad - status.goalCad)} over weekly budget.`,
      );
      continue;
    }

    const allowedToDate = (status.goalCad * daysElapsed) / 7;
    if (status.spentCad > allowedToDate) {
      paceWarnings.push(
        `${status.category.label} is ahead of pace: ${formatCad(status.remainingCad)} left for ${pluralizeDays(daysRemaining)}.`,
      );
    }
  }

  return [...overWarnings, ...paceWarnings].slice(0, 5);
}

export async function formatWeeklyBudgetReport(
  options: BudgetReportOptions = {},
): Promise<string> {
  const timezone = options.timezone ?? "America/Toronto";
  const now = options.now ?? new Date();
  const today = getDateInTimezone(now, timezone);
  const weekStart = getWeekStartForDate(today);
  const weekEnd = getWeekEndForDate(today);
  const entries = await getCurrentWeekBudgetEntries(timezone, now);
  const statuses = getWeeklyStatuses(entries);
  const totalSpent = entries.reduce((sum, entry) => sum + entry.amountCad, 0);
  const totalGoal = getWeeklyVariableGoalCad();
  const remaining = totalGoal - totalSpent;
  const daysRemaining = getDaysRemainingInWeek(today);
  const safeDailyPace = Math.max(0, remaining) / daysRemaining;
  const warnings = getWeekWarnings(statuses, today);

  const lines = [
    "Budget Week",
    `${formatShortDate(weekStart)}-${formatShortDate(weekEnd)}`,
    "",
    `Variable: ${formatCad(totalSpent)} / ${formatCad(totalGoal)}`,
    `Remaining: ${formatCad(remaining)}`,
    `Safe daily pace: ${formatCad(safeDailyPace)}/day left`,
    "",
    "Categories",
  ];

  for (const status of statuses) {
    lines.push(formatStatusLine(status));
  }

  if (warnings.length > 0) {
    lines.push("", "Watch");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (entries.length === 0) {
    lines.push("", "No variable spending logged this week.");
  }

  lines.push(
    "",
    "Commands",
    "/budget log 18.42 Starbucks",
    "/budget check 45 Amazon storage bins",
    "/budget month",
    "/budget undo",
  );

  return lines.join("\n");
}

export async function formatMonthlyBudgetReport(
  options: BudgetReportOptions = {},
): Promise<string> {
  const timezone = options.timezone ?? "America/Toronto";
  const now = options.now ?? new Date();
  const today = getDateInTimezone(now, timezone);
  const monthPrefix = getMonthPrefix(today);
  const entries = await getCurrentMonthBudgetEntries(timezone, now);
  const statuses = getMonthlyStatuses(entries);
  const totalSpent = entries.reduce((sum, entry) => sum + entry.amountCad, 0);
  const totalGoal = getMonthlyVariableGoalCad();
  const monthName = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: timezone,
  });

  const lines = [
    `Budget Month - ${monthName}`,
    "",
    `Variable: ${formatCad(totalSpent)} / ${formatCad(totalGoal)}`,
    `Remaining: ${formatCad(totalGoal - totalSpent)}`,
    "",
    "Categories",
  ];

  for (const status of statuses) {
    if (status.spentCad > 0 || status.remainingCad < 0) {
      lines.push(formatStatusLine(status));
    }
  }

  if (entries.length === 0) {
    lines.push(`No variable spending logged for ${monthPrefix}.`);
  }

  return lines.join("\n");
}

export async function formatBudgetEntryReceipt(
  entry: BudgetEntry,
): Promise<string> {
  const category = getBudgetCategory(entry.category);
  const entries = await getBudgetEntriesForWeek(entry.weekStart);
  const statuses = getWeeklyStatuses(entries);
  const status = statuses.find((item) => item.category.id === entry.category)!;
  const totalSpent = entries.reduce((sum, item) => sum + item.amountCad, 0);
  const totalGoal = getWeeklyVariableGoalCad();
  const warnings = getWeekWarnings(statuses, entry.date);

  const lines = [
    `Logged ${formatCad(entry.amountCad)} - ${category.label}`,
    entry.description,
    "",
    `Category week: ${formatCad(status.spentCad)} / ${formatCad(status.goalCad)}`,
    `Category remaining: ${formatCad(status.remainingCad)}`,
    `Variable week: ${formatCad(totalSpent)} / ${formatCad(totalGoal)}`,
  ];

  if (warnings.length > 0) {
    lines.push("", "Watch", `- ${warnings[0]!}`);
  }

  return lines.join("\n");
}

export async function formatBudgetUndoReceipt(
  entry: BudgetEntry,
): Promise<string> {
  const category = getBudgetCategory(entry.category);
  return [
    "Removed last budget entry",
    `${formatCad(entry.amountCad)} - ${category.label}`,
    entry.description,
  ].join("\n");
}

export async function formatBudgetCheckReport(
  amountCad: number,
  categoryId: BudgetCategoryId,
  description: string,
  options: BudgetReportOptions = {},
): Promise<string> {
  const timezone = options.timezone ?? "America/Toronto";
  const now = options.now ?? new Date();
  const today = getDateInTimezone(now, timezone);
  const weekStart = getWeekStartForDate(today);
  const entries = await getBudgetEntriesForWeek(weekStart);
  const currentSpent = entries
    .filter((entry) => entry.category === categoryId)
    .reduce((sum, entry) => sum + entry.amountCad, 0);
  const category = getBudgetCategory(categoryId);
  const weeklyGoal = getWeeklyGoalCad(category);
  const afterSpent = currentSpent + amountCad;
  const remainingAfter = weeklyGoal - afterSpent;
  const daysRemaining = getDaysRemainingInWeek(today);
  const lines = [
    "Budget Check",
    `${formatCad(amountCad)} - ${category.label}`,
    description,
    "",
    `Week after: ${formatCad(afterSpent)} / ${formatCad(weeklyGoal)}`,
  ];

  if (remainingAfter < 0) {
    lines.push(
      `This would put ${category.label} ${formatCad(Math.abs(remainingAfter))} over weekly budget.`,
    );
  } else {
    lines.push(
      `This stays under weekly budget and leaves ${formatCad(remainingAfter)} for ${pluralizeDays(daysRemaining)}.`,
    );
  }

  return lines.join("\n");
}
