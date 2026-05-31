const DEFAULT_TIMEZONE = "America/Toronto";

function parseDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getDateInTimezone(
  date = new Date(),
  timezone = DEFAULT_TIMEZONE,
): string {
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

export function getWeekStartForDate(date: string): string {
  const d = parseDate(date);
  const day = d.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return formatDate(d);
}

export function getWeekEndForDate(date: string): string {
  return addDays(getWeekStartForDate(date), 6);
}

export function getDaysElapsedInWeek(date: string): number {
  const d = parseDate(date);
  const day = d.getUTCDay();
  return ((day + 6) % 7) + 1;
}

export function getDaysRemainingInWeek(date: string): number {
  return 8 - getDaysElapsedInWeek(date);
}

export function getMonthPrefix(date: string): string {
  return date.slice(0, 7);
}

export function formatShortDate(date: string): string {
  const d = parseDate(date);
  const month = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${month} ${d.getUTCDate()}`;
}
