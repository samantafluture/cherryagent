import { Bot } from "grammy";
import { authMiddleware } from "./middleware.js";
import { createFoodLogHandlers } from "./handlers/food-log.js";
import { createYouTubeHandlers } from "./handlers/youtube.js";
import { createPodcastHandlers } from "./handlers/podcast.js";
import { createReportHandlers } from "./handlers/report.js";
import { createCostHandlers } from "./handlers/cost.js";
import { createInspirationHandlers } from "./handlers/inspiration.js";
import { createSpoonHandlers } from "./handlers/spoon.js";
import type { GeminiProvider } from "@cherryagent/core";
import type { FitbitAuth } from "@cherryagent/tools";

export interface BotDeps {
  token: string;
  authorizedChatId: string;
  gemini: GeminiProvider;
  fitbitAuth: FitbitAuth;
}

export function createBot(deps: BotDeps) {
  const bot = new Bot(deps.token);

  // Security: only respond to Sam's chat
  bot.use(authMiddleware(deps.authorizedChatId));

  const dailyCap = Number(process.env.AGENT_MAX_DAILY_SPEND_USD) || undefined;
  const monthlyCap = Number(process.env.AGENT_MAX_MONTHLY_SPEND_USD) || undefined;
  const costConfig = {
    timezone: process.env.USER_TIMEZONE,
    dailyCapUsd: dailyCap,
    monthlyCapUsd: monthlyCap,
  };

  const foodHandlers = createFoodLogHandlers({
    gemini: deps.gemini,
    fitbitAuth: deps.fitbitAuth,
    botToken: deps.token,
    costConfig,
  });

  const reportHandlers = createReportHandlers({
    fitbitAuth: deps.fitbitAuth,
  });

  const ytHandlers = createYouTubeHandlers({
    gemini: deps.gemini,
    botToken: deps.token,
    costConfig,
  });

  const podHandlers = createPodcastHandlers({
    gemini: deps.gemini,
    botToken: deps.token,
    costConfig,
  });

  const costHandlers = createCostHandlers(costConfig);

  const spoonHandlers = createSpoonHandlers();

  const surprideWebhookUrl = process.env.SURPRIDE_WEBHOOK_URL;
  const surprideToken = process.env.SURPRIDE_WEBHOOK_TOKEN;
  const inspoHandlers =
    surprideWebhookUrl && surprideToken
      ? createInspirationHandlers({
          botToken: deps.token,
          surprideWebhookUrl,
          surprideToken,
        })
      : null;

  // Commands
  bot.command("start", (ctx) =>
    ctx.reply("CherryAgent ready. Send food to log or /yt for YouTube!"),
  );
  bot.command("fitbit_auth", async (ctx) => {
    const url = deps.fitbitAuth.getAuthUrl();
    await ctx.reply(
      `Open this link to connect Fitbit:\n${url}\n\nAfter authorizing, the callback will save your tokens automatically.`,
    );
  });
  bot.command("food", foodHandlers.handleFoodCommand);
  bot.command("fav", foodHandlers.handleFavCommand);
  bot.command("yt", ytHandlers.handleYtCommand);
  bot.command("pod", podHandlers.handlePodCommand);
  bot.command("report", reportHandlers.handleReportCommand);
  bot.command("cost", costHandlers.handleCostCommand);
  bot.command("spoon", spoonHandlers.handleSpoonCommand);
  if (inspoHandlers) {
    bot.command("inspo", inspoHandlers.handleInspoCommand);
  }

  // Set bot command menu
  bot.api.setMyCommands([
    { command: "food", description: "Food logger help & commands" },
    { command: "fav", description: "Saved foods — list, log, or remove" },
    { command: "report", description: "Saturated fat report (today + weekly)" },
    { command: "yt", description: "YouTube — augmented notes from any video" },
    { command: "pod", description: "Podcast — augmented notes from any episode" },
    { command: "cost", description: "AI spend report — today, week, month" },
    { command: "inspo", description: "Upload photo to Inspiration Board" },
    { command: "spoon", description: "Spoon tracker — morning/evening check-in, report" },
  ]);

  // Photo handler — route by caption
  bot.on("message:photo", (ctx) => {
    const caption = ctx.message.caption ?? "";
    if (caption.startsWith("/inspo") && inspoHandlers) {
      return inspoHandlers.handleInspoPhoto(ctx);
    }
    return foodHandlers.handlePhoto(ctx);
  });

  // Text handler — spoon → food
  bot.on("message:text", async (ctx) => {
    const spoonHandled = await spoonHandlers.handleText(ctx);
    if (!spoonHandled) return foodHandlers.handleText(ctx);
  });

  // Callback queries (confirmation buttons)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (data.startsWith("spoon_")) {
      return spoonHandlers.handleCallback(ctx);
    }
    return foodHandlers.handleCallback(ctx);
  });

  // Error handler — log errors instead of crashing silently
  bot.catch((err) => {
    console.error("Bot error:", err.message);
    console.error(err.stack);
  });

  return bot;
}
