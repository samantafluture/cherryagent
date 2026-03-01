import { createServer } from "./server.js";
import { createBot } from "./telegram/bot.js";
import { GeminiProvider } from "@cherryagent/core";
import { FitbitAuth } from "@cherryagent/tools";

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

  // Start Fastify (health + Fitbit OAuth callback)
  const server = await createServer({ fitbitAuth });
  await server.listen({ port: PORT, host: HOST });
  console.log(`CherryAgent API listening on ${HOST}:${PORT}`);

  // Start Telegram bot (long polling for local dev)
  const bot = createBot({
    token: requireEnv("TELEGRAM_BOT_TOKEN"),
    authorizedChatId: requireEnv("TELEGRAM_CHAT_ID"),
    gemini,
    fitbitAuth,
  });

  bot.start({
    onStart: () => console.log("Telegram bot started (long polling)"),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
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
