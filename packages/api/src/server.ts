import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { fitbitCallbackRoute } from "./routes/fitbit-callback.js";
import { fitbitHealthSummaryRoute } from "./routes/fitbit-health-summary.js";
import { githubWebhookRoute } from "./routes/github-webhook.js";
import type { FitbitAuth, GitSyncResult } from "@cherryagent/tools";

interface ServerDeps {
  fitbitAuth?: FitbitAuth;
  timezone?: string;
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
    await app.register(
      fitbitHealthSummaryRoute(
        deps.fitbitAuth,
        deps.timezone ?? "America/Toronto",
      ),
    );
  }

  if (deps?.githubWebhook) {
    await app.register(githubWebhookRoute(deps.githubWebhook));
  }

  return app;
}
