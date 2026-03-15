import { createServer } from "./server.js";
import { createBot } from "./telegram/bot.js";
import { GeminiProvider, GroqWhisperClient } from "@cherryagent/core";
import { FitbitAuth, getMediaConfig, startMediaCleanup, startWeeklyReport, listProjects, startSyncScheduler } from "@cherryagent/tools";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  // Initialize providers
  const gemini = new GeminiProvider({
    apiKey: requireEnv("GEMINI_API_KEY"),
  });

  const fitbitAuth = new FitbitAuth({
    clientId: requireEnv("FITBIT_CLIENT_ID"),
    clientSecret: requireEnv("FITBIT_CLIENT_SECRET"),
    redirectUri:
      process.env["FITBIT_REDIRECT_URI"] ??
      "http://localhost:3000/api/fitbit/callback",
  });

  const whisper = new GroqWhisperClient({
    apiKey: requireEnv("GROQ_API_KEY"),
  });

  const mediaConfig = getMediaConfig();

  // Start media cleanup (every 6 hours)
  const cleanupTimer = startMediaCleanup(mediaConfig);

  // Discover projects with tasks.md and start sync scheduler (every 5 min)
  const projects = listProjects();
  const repoPaths = projects.map((p) => p.repoPath);
  const sendConflictNotification = async (repoPath: string, message: string) => {
    await fetch(
      `https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: requireEnv("TELEGRAM_CHAT_ID"),
          text: `⚠️ <b>Git sync conflict</b>\n<code>${repoPath}</code>\n${message}`,
          parse_mode: "HTML",
        }),
      },
    );
  };

  const syncTimer = startSyncScheduler({
    repoPaths,
    onConflict: (repoPath, result) => {
      console.warn(`[sync] Conflict in ${repoPath}: ${result.message}`);
      sendConflictNotification(repoPath, result.message);
    },
  });

  // Build GitHub webhook repo map (full_name → local path)
  const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  const repoMap = new Map<string, string>();
  const githubUser = process.env["GITHUB_USER"] ?? "samantafluture";
  for (const p of projects) {
    repoMap.set(`${githubUser}/${p.slug}`, p.repoPath);
  }

  // Start Fastify (health + Fitbit OAuth + GitHub webhook)
  const server = await createServer({
    fitbitAuth,
    githubWebhook: webhookSecret
      ? {
          repoMap,
          webhookSecret,
          onConflict: (repoPath, result) => {
            console.warn(`[webhook] Conflict in ${repoPath}: ${result.message}`);
            sendConflictNotification(repoPath, result.message);
          },
        }
      : undefined,
  });
  await server.listen({ port: PORT, host: HOST });
  console.log(`CherryAgent API listening on ${HOST}:${PORT}`);
  console.log(`[sync] Tracking ${projects.length} projects: ${projects.map((p) => p.slug).join(", ")}`);

  // Start weekly saturated fat report (Monday 8 AM)
  const telegramChatId = requireEnv("TELEGRAM_CHAT_ID");
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const weeklyReportTimer = startWeeklyReport({
    fitbitAuth,
    timezone: process.env.USER_TIMEZONE,
    sendMessage: async (html) => {
      await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: html,
            parse_mode: "HTML",
          }),
        },
      );
    },
  });

  // Start Telegram bot (long polling for local dev)
  const bot = createBot({
    token: botToken,
    authorizedChatId: telegramChatId,
    gemini,
    fitbitAuth,
    whisper,
    mediaConfig,
  });

  bot.start({
    onStart: () => console.log("Telegram bot started (long polling)"),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    clearInterval(cleanupTimer);
    clearInterval(weeklyReportTimer);
    clearInterval(syncTimer);
    await bot.stop();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
