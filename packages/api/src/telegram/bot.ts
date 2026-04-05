import { Bot } from "grammy";
import { authMiddleware } from "./middleware.js";
import { createFoodLogHandlers } from "./handlers/food-log.js";
import { createYouTubeHandlers } from "./handlers/youtube.js";
import { createInsightsHandlers } from "./handlers/youtube-insights.js";
import { createReportHandlers } from "./handlers/report.js";
import { createCostHandlers } from "./handlers/cost.js";
import { createInspirationHandlers } from "./handlers/inspiration.js";
import { createBlogHandlers } from "./handlers/blog.js";
import { createVoiceHandlers } from "./handlers/voice.js";
import { createSpoonHandlers } from "./handlers/spoon.js";
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
    botToken: deps.token,
    mediaConfig: deps.mediaConfig,
    costConfig,
  });

  const insightsHandlers = createInsightsHandlers({
    gemini: deps.gemini,
    costConfig,
  });

  const costHandlers = createCostHandlers(costConfig);

  const blogHandlers = createBlogHandlers();

  const spoonHandlers = createSpoonHandlers();

  const voiceHandlers = createVoiceHandlers({
    gemini: deps.gemini,
    botToken: deps.token,
    costConfig,
  });

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
  bot.command("blog", blogHandlers.handleBlogCommand);
  bot.command("spoon", spoonHandlers.handleSpoonCommand);
  bot.command("voicereset", voiceHandlers.handleVoiceReset);
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
    { command: "blog", description: "Blog — ideas, drafts, status" },
    { command: "spoon", description: "Spoon tracker — morning/evening check-in, report" },
    { command: "voicereset", description: "Clear active voice coding session" },
  ]);

  // Voice message handler
  bot.on("message:voice", voiceHandlers.handleVoice);

  // Photo handler — route by caption
  bot.on("message:photo", (ctx) => {
    const caption = ctx.message.caption ?? "";
    if (caption.startsWith("/inspo") && inspoHandlers) {
      return inspoHandlers.handleInspoPhoto(ctx);
    }
    return foodHandlers.handlePhoto(ctx);
  });

  // Document handler — cookies upload
  bot.on("message:document", (ctx) => {
    const name = (ctx.message.document.file_name ?? "").toLowerCase();
    const caption = (ctx.message.caption ?? "").toLowerCase();
    if (name.endsWith(".txt") && (name.includes("cookie") || caption === "/cookies")) {
      return ytHandlers.handleCookiesUpload(ctx);
    }
    // Future: other document types can be handled here
  });

  // Text handler — voice edit → insights interview → spoon → food
  bot.on("message:text", async (ctx) => {
    const voiceHandled = await voiceHandlers.handleVoiceText(ctx);
    if (voiceHandled) return;
    const insightsHandled = await insightsHandlers.handleText(ctx);
    if (insightsHandled) return;
    const spoonHandled = await spoonHandlers.handleText(ctx);
    if (!spoonHandled) return foodHandlers.handleText(ctx);
  });

  // Callback queries (confirmation buttons)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (data.startsWith("spoon_")) {
      return spoonHandlers.handleCallback(ctx);
    }
    if (data.startsWith("voice_")) {
      return voiceHandlers.handleVoiceCallback(ctx);
    }
    if (data.startsWith("yt_insights_")) {
      return insightsHandlers.handleCallback(ctx);
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
