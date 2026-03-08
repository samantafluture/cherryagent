import type { Context } from "grammy";
import { formatCostReport, checkSpendWarning } from "@cherryagent/tools";

interface CostDeps {
  timezone?: string;
  dailyCapUsd?: number;
  monthlyCapUsd?: number;
}

export function createCostHandlers(deps: CostDeps) {
  const config = {
    timezone: deps.timezone,
    dailyCapUsd: deps.dailyCapUsd,
    monthlyCapUsd: deps.monthlyCapUsd,
  };

  async function handleCostCommand(ctx: Context) {
    const report = await formatCostReport(config);
    return ctx.reply(report);
  }

  return { handleCostCommand, config };
}
