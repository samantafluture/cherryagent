import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SpoonEntry {
  date: string; // YYYY-MM-DD
  type: "morning" | "evening";
  timestamp: number;
  spoonLevel: number; // 1-5
  energyCosts?: string; // morning: what's ahead; evening: what cost the most
  protect?: string; // morning only
  restored?: string; // evening only
  maskEvents?: string; // evening only
}

const TRACKER_DIR = join(homedir(), ".cherryagent");
const TRACKER_PATH = join(TRACKER_DIR, "spoon-log.json");

async function readEntries(): Promise<SpoonEntry[]> {
  try {
    const raw = await readFile(TRACKER_PATH, "utf-8");
    return JSON.parse(raw) as SpoonEntry[];
  } catch {
    return [];
  }
}

async function writeEntries(entries: SpoonEntry[]): Promise<void> {
  await mkdir(TRACKER_DIR, { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function logSpoon(entry: SpoonEntry): Promise<void> {
  const entries = await readEntries();
  // Replace existing entry for same date+type
  const idx = entries.findIndex(
    (e) => e.date === entry.date && e.type === entry.type,
  );
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  await writeEntries(entries);
}

export async function getSpoonForDate(date: string): Promise<SpoonEntry[]> {
  const entries = await readEntries();
  return entries.filter((e) => e.date === date);
}

export async function getSpoonForRange(
  startDate: string,
  endDate: string,
): Promise<SpoonEntry[]> {
  const entries = await readEntries();
  return entries.filter((e) => e.date >= startDate && e.date <= endDate);
}
