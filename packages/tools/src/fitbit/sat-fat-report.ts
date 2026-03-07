import type { DailySummary, WeeklySummary } from "./food-log-reader.js";

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

function ratingEmoji(rating: DailySummary["rating"]): string {
  return rating === "Good" ? "Good" : "Needs improvement";
}

function formatDayLine(day: DailySummary): string {
  return `${formatDate(day.date)}: ${day.saturatedFatGrams}g — ${ratingEmoji(day.rating)}`;
}

export function formatOnDemandReport(
  today: DailySummary,
  weekly: WeeklySummary,
): string {
  const lines = [
    "<b>Saturated Fat Report</b>",
    "",
    `Today (${formatDate(today.date)}): ${today.saturatedFatGrams}g / 13g — ${ratingEmoji(today.rating)}`,
    "",
    "<b>Last 7 days:</b>",
    ...weekly.days.map(formatDayLine),
    "",
    `Weekly avg: ${weekly.averageSaturatedFat}g — ${ratingEmoji(weekly.rating)}`,
    "AHA guideline: &lt;13g/day (5-6% of 2000 cal)",
  ];
  return lines.join("\n");
}

export function formatWeeklyReport(weekly: WeeklySummary): string {
  const lines = [
    "<b>Weekly Saturated Fat Report</b>",
    "",
    ...weekly.days.map(formatDayLine),
    "",
    `Weekly avg: ${weekly.averageSaturatedFat}g — ${ratingEmoji(weekly.rating)}`,
    "AHA guideline: &lt;13g/day (5-6% of 2000 cal)",
  ];
  return lines.join("\n");
}
