import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { fitbitCallbackRoute } from "./routes/fitbit-callback.js";
import { githubWebhookRoute } from "./routes/github-webhook.js";
import type { FitbitAuth, GitSyncResult } from "@cherryagent/tools";

interface ServerDeps {
  fitbitAuth?: FitbitAuth;
  githubWebhook?: {
    repoMap: Map<string, string>;
    webhookSecret: string;
    onConflict?: (repoPath: string, result: GitSyncResult) => void;
  };
}

export async function createServer(deps?: ServerDeps) {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  });

  await app.register(healthRoutes);

  if (deps?.fitbitAuth) {
    await app.register(fitbitCallbackRoute(deps.fitbitAuth));
  }

  if (deps?.githubWebhook) {
    await app.register(githubWebhookRoute(deps.githubWebhook));
  }

  return app;
}
