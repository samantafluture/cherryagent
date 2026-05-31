import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BudgetCategoryId,
  isBudgetCategoryId,
} from "./categories.js";
import {
  getDateInTimezone,
  getMonthPrefix,
  getWeekStartForDate,
} from "./date.js";

export interface BudgetEntry {
  id: string;
  timestamp: number;
  date: string;
  weekStart: string;
  amountCad: number;
  category: BudgetCategoryId;
  description: string;
}

interface LogBudgetEntryInput {
  amountCad: number;
  category: BudgetCategoryId;
  description: string;
  timezone?: string;
  timestamp?: number;
}

const TRACKER_DIR = join(homedir(), ".cherryagent");
const TRACKER_PATH = join(TRACKER_DIR, "budget-log.json");
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(timestamp: number): string {
  let value = timestamp;
  const chars: string[] = [];
  for (let i = 0; i < 10; i++) {
    chars.unshift(CROCKFORD_BASE32[value % 32]!);
    value = Math.floor(value / 32);
  }
  return chars.join("");
}

function createUlid(timestamp: number): string {
  const bytes = randomBytes(10);
  let random = "";
  for (let i = 0; i < 16; i++) {
    const byte = bytes[i % bytes.length]!;
    random += CROCKFORD_BASE32[byte % 32]!;
  }
  return `${encodeTime(timestamp)}${random}`;
}

function parseBudgetEntry(value: unknown): BudgetEntry | null {
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (typeof record.timestamp !== "number") return null;
  if (typeof record.date !== "string") return null;
  if (typeof record.weekStart !== "string") return null;
  if (typeof record.amountCad !== "number") return null;
  if (typeof record.category !== "string") return null;
  if (!isBudgetCategoryId(record.category)) return null;
  if (typeof record.description !== "string") return null;

  return {
    id: record.id,
    timestamp: record.timestamp,
    date: record.date,
    weekStart: record.weekStart,
    amountCad: record.amountCad,
    category: record.category,
    description: record.description,
  };
}

async function readEntries(): Promise<BudgetEntry[]> {
  try {
    const raw = await readFile(TRACKER_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseBudgetEntry)
      .filter((entry): entry is BudgetEntry => entry != null);
  } catch {
    return [];
  }
}

async function writeEntries(entries: BudgetEntry[]): Promise<void> {
  await mkdir(TRACKER_DIR, { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function logBudgetEntry(
  input: LogBudgetEntryInput,
): Promise<BudgetEntry> {
  const timestamp = input.timestamp ?? Date.now();
  const date = getDateInTimezone(
    new Date(timestamp),
    input.timezone ?? "America/Toronto",
  );
  const entry: BudgetEntry = {
    id: createUlid(timestamp),
    timestamp,
    date,
    weekStart: getWeekStartForDate(date),
    amountCad: input.amountCad,
    category: input.category,
    description: input.description.trim(),
  };

  const entries = await readEntries();
  entries.push(entry);
  await writeEntries(entries);
  return entry;
}

export async function getBudgetEntriesForWeek(
  weekStart: string,
): Promise<BudgetEntry[]> {
  const entries = await readEntries();
  return entries.filter((entry) => entry.weekStart === weekStart);
}

export async function getCurrentWeekBudgetEntries(
  timezone?: string,
  now = new Date(),
): Promise<BudgetEntry[]> {
  const today = getDateInTimezone(now, timezone ?? "America/Toronto");
  return getBudgetEntriesForWeek(getWeekStartForDate(today));
}

export async function getCurrentMonthBudgetEntries(
  timezone?: string,
  now = new Date(),
): Promise<BudgetEntry[]> {
  const today = getDateInTimezone(now, timezone ?? "America/Toronto");
  const monthPrefix = getMonthPrefix(today);
  const entries = await readEntries();
  return entries.filter((entry) => entry.date.startsWith(monthPrefix));
}

export async function undoLastBudgetEntry(): Promise<BudgetEntry | null> {
  const entries = await readEntries();
  if (entries.length === 0) return null;

  let latestIndex = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.timestamp > entries[latestIndex]!.timestamp) {
      latestIndex = i;
    }
  }

  const [removed] = entries.splice(latestIndex, 1);
  await writeEntries(entries);
  return removed ?? null;
}
