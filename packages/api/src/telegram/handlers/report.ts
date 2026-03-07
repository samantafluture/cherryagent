import type { Context } from "grammy";
import {
  FitbitFoodLogReader,
  formatOnDemandReport,
  type FitbitAuth,
} from "@cherryagent/tools";

interface ReportDeps {
  fitbitAuth: FitbitAuth;
}

export function createReportHandlers(deps: ReportDeps) {
  const reader = new FitbitFoodLogReader(
    deps.fitbitAuth,
    process.env.USER_TIMEZONE,
  );

  async function handleReportCommand(ctx: Context) {
    await ctx.reply("Fetching report...");

    try {
      const now = new Date(
        new Date().toLocaleString("en-US", {
          timeZone: process.env.USER_TIMEZONE ?? "America/Toronto",
        }),
      );
      const todayStr = now.toLocaleDateString("en-CA");

      const [today, weekly] = await Promise.all([
        reader.getDailySummary(todayStr),
        reader.getWeeklySummary(todayStr),
      ]);

      const html = formatOnDemandReport(today, weekly);
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`Failed to fetch report: ${msg}`);
    }
  }

  return { handleReportCommand };
}
