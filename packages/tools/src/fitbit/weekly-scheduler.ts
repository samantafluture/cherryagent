import { FitbitFoodLogReader } from "./food-log-reader.js";
import { formatWeeklyReport } from "./sat-fat-report.js";
import type { FitbitAuth } from "./auth.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REPORT_DAY = 1; // Monday (0=Sunday, 1=Monday)
const REPORT_HOUR = 8; // 8 AM local

interface WeeklyReportDeps {
  fitbitAuth: FitbitAuth;
  timezone?: string;
  sendMessage: (html: string) => Promise<void>;
  reportDay?: number;
}

export function startWeeklyReport(
  deps: WeeklyReportDeps,
): ReturnType<typeof setInterval> {
  const {
    fitbitAuth,
    timezone = "America/Toronto",
    sendMessage,
    reportDay = REPORT_DAY,
  } = deps;
  const reader = new FitbitFoodLogReader(fitbitAuth, timezone);
  let lastSentDate = "";

  async function check() {
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: timezone }),
    );
    const todayStr = now.toLocaleDateString("en-CA");

    if (
      now.getDay() !== reportDay ||
      now.getHours() < REPORT_HOUR ||
      lastSentDate === todayStr
    ) {
      return;
    }

    try {
      const weekly = await reader.getWeeklySummary();
      const html = formatWeeklyReport(weekly);
      await sendMessage(html);
      lastSentDate = todayStr;
      console.log("[weekly-report] Sent weekly saturated fat report");
    } catch (err) {
      console.error("[weekly-report] Failed to send:", err);
    }
  }

  // Check on startup
  check();

  return setInterval(check, CHECK_INTERVAL_MS);
}
