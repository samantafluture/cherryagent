import { getCostsForDate, getCostsForRange, getMonthlyCost } from "./cost-tracker.js";
import type { CostEntry } from "./cost-tracker.js";

interface CostReportConfig {
  timezone?: string;
  dailyCapUsd?: number;
  monthlyCapUsd?: number;
}

function getToday(timezone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

function getLast7Days(timezone: string): string[] {
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("en-CA", { timeZone: timezone }));
  }
  return dates;
}

function groupByKey(
  entries: CostEntry[],
  key: "workflow" | "provider",
): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(e[key], (map.get(e[key]) ?? 0) + e.costUsd);
  }
  return map;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export async function formatCostReport(config: CostReportConfig = {}): Promise<string> {
  const tz = config.timezone ?? "America/Toronto";
  const today = getToday(tz);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // Today
  const todayEntries = await getCostsForDate(today);
  const todayTotal = todayEntries.reduce((s, e) => s + e.costUsd, 0);
  const todayByWorkflow = groupByKey(todayEntries, "workflow");

  // Week (last 7 days)
  const weekDays = getLast7Days(tz);
  const weekEntries = await getCostsForRange(weekDays[0]!, weekDays[6]!);
  const weekTotal = weekEntries.reduce((s, e) => s + e.costUsd, 0);

  // Month
  const monthTotal = await getMonthlyCost(year, month);

  // Build report
  const lines: string[] = [];

  // Today section
  lines.push(`📊 Cost Report`);
  lines.push(``);
  lines.push(`Today (${today}): ${formatUsd(todayTotal)}`);
  if (todayByWorkflow.size > 0) {
    for (const [wf, cost] of todayByWorkflow) {
      lines.push(`  ${wf}: ${formatUsd(cost)}`);
    }
  }
  if (config.dailyCapUsd) {
    const pct = Math.round((todayTotal / config.dailyCapUsd) * 100);
    lines.push(`  Cap: ${formatUsd(todayTotal)} / ${formatUsd(config.dailyCapUsd)} (${pct}%)`);
  }

  // Week section
  lines.push(``);
  lines.push(`This week: ${formatUsd(weekTotal)}`);

  // Daily breakdown for the week
  const weekByDay = new Map<string, number>();
  for (const e of weekEntries) {
    weekByDay.set(e.date, (weekByDay.get(e.date) ?? 0) + e.costUsd);
  }
  for (const day of weekDays) {
    const dayCost = weekByDay.get(day) ?? 0;
    if (dayCost > 0) {
      const weekday = new Date(day + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
      });
      lines.push(`  ${weekday} ${day.slice(5)}: ${formatUsd(dayCost)}`);
    }
  }

  // Month section
  const monthName = now.toLocaleDateString("en-US", { month: "long" });
  lines.push(``);
  lines.push(`${monthName}: ${formatUsd(monthTotal)}`);
  if (config.monthlyCapUsd) {
    const pct = Math.round((monthTotal / config.monthlyCapUsd) * 100);
    lines.push(`  Cap: ${formatUsd(monthTotal)} / ${formatUsd(config.monthlyCapUsd)} (${pct}%)`);
  }

  return lines.join("\n");
}

export async function checkSpendWarning(config: CostReportConfig = {}): Promise<string | null> {
  const tz = config.timezone ?? "America/Toronto";
  const today = getToday(tz);
  const now = new Date();
  const warnings: string[] = [];

  if (config.dailyCapUsd) {
    const todayEntries = await getCostsForDate(today);
    const todayTotal = todayEntries.reduce((s, e) => s + e.costUsd, 0);
    const pct = todayTotal / config.dailyCapUsd;
    if (pct >= 0.9) {
      warnings.push(
        `⚠️ Daily spend at ${Math.round(pct * 100)}% — ${formatUsd(todayTotal)} / ${formatUsd(config.dailyCapUsd)}`,
      );
    }
  }

  if (config.monthlyCapUsd) {
    const monthTotal = await getMonthlyCost(now.getFullYear(), now.getMonth() + 1);
    const pct = monthTotal / config.monthlyCapUsd;
    if (pct >= 0.8) {
      warnings.push(
        `⚠️ Monthly spend at ${Math.round(pct * 100)}% — ${formatUsd(monthTotal)} / ${formatUsd(config.monthlyCapUsd)}`,
      );
    }
  }

  return warnings.length > 0 ? warnings.join("\n") : null;
}
