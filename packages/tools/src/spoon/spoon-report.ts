import type { SpoonEntry } from "./spoon-tracker.js";

const LEVEL_COLORS = ["⬛", "🟥", "🟧", "🟨", "🟩", "🟩"] as const;

function spoonBar(level: number): string {
  const blocks: string[] = [];
  for (let i = 1; i <= 5; i++) {
    blocks.push(i <= level ? LEVEL_COLORS[level]! : "⬜");
  }
  return blocks.join("");
}

function shortDay(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${day} ${mm}/${dd}`;
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[,\n]|(?:\band\b)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function formatSpoonReport(
  entries: SpoonEntry[],
  days: number,
): string {
  if (entries.length === 0) {
    return `🥄 No spoon data for the last ${days} days.`;
  }

  // Group by date
  const byDate = new Map<string, { morning?: SpoonEntry; evening?: SpoonEntry }>();
  for (const e of entries) {
    const existing = byDate.get(e.date) ?? {};
    existing[e.type] = e;
    byDate.set(e.date, existing);
  }

  // Generate all dates in range
  const now = new Date();
  const allDates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    allDates.push(d.toLocaleDateString("en-CA"));
  }

  // Daily trend
  const trendLines: string[] = [];
  let streak = 0;
  let currentStreak = 0;
  const morningLevels: number[] = [];
  const eveningLevels: number[] = [];
  const drainWords: string[] = [];
  const restoreWords: string[] = [];
  const maskList: { date: string; text: string }[] = [];

  for (const date of allDates) {
    const day = byDate.get(date);
    if (!day || (!day.morning && !day.evening)) {
      trendLines.push(`${shortDay(date)}  — no check-in —`);
      currentStreak = 0;
      continue;
    }

    currentStreak++;
    if (currentStreak > streak) streak = currentStreak;

    const m = day.morning;
    const e = day.evening;

    if (m && e) {
      const diff = e.spoonLevel - m.spoonLevel;
      const sign = diff > 0 ? "+" : "";
      trendLines.push(
        `${shortDay(date)}  ${spoonBar(m.spoonLevel)} → ${spoonBar(e.spoonLevel)}  (${m.spoonLevel}→${e.spoonLevel}, ${sign}${diff})`,
      );
    } else if (m) {
      trendLines.push(`${shortDay(date)}  ${spoonBar(m.spoonLevel)} → —  (${m.spoonLevel}→?)`);
    } else if (e) {
      trendLines.push(`${shortDay(date)}  — → ${spoonBar(e.spoonLevel)}  (?→${e.spoonLevel})`);
    }

    if (m) {
      morningLevels.push(m.spoonLevel);
      if (m.energyCosts) drainWords.push(...extractKeywords(m.energyCosts));
    }
    if (e) {
      eveningLevels.push(e.spoonLevel);
      if (e.energyCosts) drainWords.push(...extractKeywords(e.energyCosts));
      if (e.restored) restoreWords.push(...extractKeywords(e.restored));
      if (e.maskEvents) {
        maskList.push({
          date: shortDay(date),
          text: e.maskEvents.trim(),
        });
      }
    }
  }

  // Averages
  const avgMorning =
    morningLevels.length > 0
      ? (morningLevels.reduce((a, b) => a + b, 0) / morningLevels.length).toFixed(1)
      : "—";
  const avgEvening =
    eveningLevels.length > 0
      ? (eveningLevels.reduce((a, b) => a + b, 0) / eveningLevels.length).toFixed(1)
      : "—";

  let avgSpent = "—";
  if (morningLevels.length > 0 && eveningLevels.length > 0) {
    const mAvg = morningLevels.reduce((a, b) => a + b, 0) / morningLevels.length;
    const eAvg = eveningLevels.reduce((a, b) => a + b, 0) / eveningLevels.length;
    avgSpent = (mAvg - eAvg).toFixed(1);
  }

  // Frequency counts
  const drainCounts = countFrequency(drainWords);
  const restoreCounts = countFrequency(restoreWords);

  // Build report
  const lines: string[] = [
    `🥄 Spoon Report (${days} days)`,
    "",
    "📊 Daily Trend",
    ...trendLines,
    "",
    "📈 Averages",
    `  Morning: ${avgMorning} / 5`,
    `  Evening: ${avgEvening} / 5`,
    `  Avg spent: ${avgSpent} / day`,
  ];

  if (drainCounts.length > 0) {
    lines.push("", "🔻 Top Energy Drains");
    for (const [word, count] of drainCounts.slice(0, 5)) {
      lines.push(`  • ${word} (${count}x)`);
    }
  }

  if (restoreCounts.length > 0) {
    lines.push("", "🔺 What Restores");
    for (const [word, count] of restoreCounts.slice(0, 5)) {
      lines.push(`  • ${word} (${count}x)`);
    }
  }

  lines.push("", `🎭 Mask Events: ${maskList.length} in ${days} days`);
  for (const m of maskList) {
    lines.push(`  ${m.date} — "${m.text}"`);
  }

  lines.push("", `✅ Streak: ${streak} consecutive days logged`);

  return lines.join("\n");
}

function countFrequency(words: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const w of words) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
