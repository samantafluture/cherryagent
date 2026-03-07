import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface SatFatEntry {
  date: string;
  foodName: string;
  grams: number;
  loggedAt: number;
}

const TRACKER_DIR = join(homedir(), ".cherryagent");
const TRACKER_PATH = join(TRACKER_DIR, "sat-fat-log.json");

async function readEntries(): Promise<SatFatEntry[]> {
  try {
    const raw = await readFile(TRACKER_PATH, "utf-8");
    return JSON.parse(raw) as SatFatEntry[];
  } catch {
    return [];
  }
}

async function writeEntries(entries: SatFatEntry[]): Promise<void> {
  await mkdir(TRACKER_DIR, { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function trackSaturatedFat(
  date: string,
  foodName: string,
  grams: number,
): Promise<void> {
  const entries = await readEntries();
  entries.push({ date, foodName, grams, loggedAt: Date.now() });
  await writeEntries(entries);
}

export async function getDailySaturatedFat(date: string): Promise<number> {
  const entries = await readEntries();
  return entries
    .filter((e) => e.date === date)
    .reduce((sum, e) => sum + e.grams, 0);
}

export async function getWeeklySaturatedFat(
  dates: string[],
): Promise<Map<string, number>> {
  const entries = await readEntries();
  const result = new Map<string, number>();
  for (const date of dates) {
    const total = entries
      .filter((e) => e.date === date)
      .reduce((sum, e) => sum + e.grams, 0);
    result.set(date, total);
  }
  return result;
}
