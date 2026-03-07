import { Bot } from "grammy";
import { authMiddleware } from "./middleware.js";
import { createFoodLogHandlers } from "./handlers/food-log.js";
import { createYouTubeHandlers } from "./handlers/youtube.js";
import { createReportHandlers } from "./handlers/report.js";
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

  const foodHandlers = createFoodLogHandlers({
    gemini: deps.gemini,
    fitbitAuth: deps.fitbitAuth,
    botToken: deps.token,
  });

  const reportHandlers = createReportHandlers({
    fitbitAuth: deps.fitbitAuth,
  });

  const ytHandlers = createYouTubeHandlers({
    whisper: deps.whisper,
    gemini: deps.gemini,
    mediaConfig: deps.mediaConfig,
  });

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
  bot.command("yt", ytHandlers.handleYtCommand);
  bot.command("report", reportHandlers.handleReportCommand);

  // Photo handler (label, food photo, or barcode photo)
  bot.on("message:photo", foodHandlers.handlePhoto);

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
