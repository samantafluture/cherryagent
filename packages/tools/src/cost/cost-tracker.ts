import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CostEntry {
  timestamp: number;
  date: string; // YYYY-MM-DD
  workflow: string; // "youtube" | "food" | etc.
  provider: string; // "gemini" | "groq-whisper" | etc.
  costUsd: number;
  detail?: string; // e.g. "notes generation", "food parse"
}

const TRACKER_DIR = join(homedir(), ".cherryagent");
const TRACKER_PATH = join(TRACKER_DIR, "cost-log.json");

async function readEntries(): Promise<CostEntry[]> {
  try {
    const raw = await readFile(TRACKER_PATH, "utf-8");
    return JSON.parse(raw) as CostEntry[];
  } catch {
    return [];
  }
}

async function writeEntries(entries: CostEntry[]): Promise<void> {
  await mkdir(TRACKER_DIR, { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function logCost(
  workflow: string,
  provider: string,
  costUsd: number,
  detail?: string,
  timezone?: string,
): Promise<void> {
  const entries = await readEntries();
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: timezone ?? "America/Toronto",
  });
  entries.push({
    timestamp: Date.now(),
    date,
    workflow,
    provider,
    costUsd,
    detail,
  });
  await writeEntries(entries);
}

export async function getCostsForDate(date: string): Promise<CostEntry[]> {
  const entries = await readEntries();
  return entries.filter((e) => e.date === date);
}

export async function getCostsForRange(
  startDate: string,
  endDate: string,
): Promise<CostEntry[]> {
  const entries = await readEntries();
  return entries.filter((e) => e.date >= startDate && e.date <= endDate);
}

export async function getDailyCost(date: string): Promise<number> {
  const entries = await getCostsForDate(date);
  return entries.reduce((sum, e) => sum + e.costUsd, 0);
}

export async function getMonthlyCost(
  year: number,
  month: number,
): Promise<number> {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const entries = await readEntries();
  return entries
    .filter((e) => e.date.startsWith(prefix))
    .reduce((sum, e) => sum + e.costUsd, 0);
}
