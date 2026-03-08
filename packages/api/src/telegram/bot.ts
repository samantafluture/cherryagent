import { Bot } from "grammy";
import { authMiddleware } from "./middleware.js";
import { createFoodLogHandlers } from "./handlers/food-log.js";
import { createYouTubeHandlers } from "./handlers/youtube.js";
import { createReportHandlers } from "./handlers/report.js";
import { createCostHandlers } from "./handlers/cost.js";
import { createInspirationHandlers } from "./handlers/inspiration.js";
import type { GeminiProvider, GroqWhisperClient } from "@cherryagent/core";
import type { FitbitAuth, MediaConfig } from "@cherryagent/tools";

export interface BotDeps {
  token: string;
  authorizedChatId: string;
  gemini: GeminiProvider;
  fitbitAuth: FitbitAuth;
  whisper: GroqWhisperClient;
  mediaConfig: MediaConfig;
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
    whisper: deps.whisper,
    gemini: deps.gemini,
    mediaConfig: deps.mediaConfig,
    costConfig,
  });

  const costHandlers = createCostHandlers(costConfig);

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
  bot.command("report", reportHandlers.handleReportCommand);
  bot.command("cost", costHandlers.handleCostCommand);
  if (inspoHandlers) {
    bot.command("inspo", inspoHandlers.handleInspoCommand);
  }

  // Set bot command menu
  bot.api.setMyCommands([
    { command: "food", description: "Food logger help & commands" },
    { command: "fav", description: "Saved foods — list, log, or remove" },
    { command: "report", description: "Saturated fat report (today + weekly)" },
    { command: "yt", description: "YouTube — download, transcribe, notes" },
    { command: "cost", description: "AI spend report — today, week, month" },
    { command: "inspo", description: "Upload photo to Inspiration Board" },
  ]);

  // Photo handler — route by caption
  bot.on("message:photo", (ctx) => {
    const caption = ctx.message.caption ?? "";
    if (caption.startsWith("/inspo") && inspoHandlers) {
      return inspoHandlers.handleInspoPhoto(ctx);
    }
    return foodHandlers.handlePhoto(ctx);
  });

  // Text handler (natural language or barcode number)
  bot.on("message:text", foodHandlers.handleText);

  // Callback queries (confirmation buttons)
  bot.on("callback_query:data", foodHandlers.handleCallback);

  // Error handler — log errors instead of crashing silently
  bot.catch((err) => {
    console.error("Bot error:", err.message);
    console.error(err.stack);
  });

  return bot;
}
