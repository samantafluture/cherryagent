import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { fitbitCallbackRoute } from "./routes/fitbit-callback.js";
import { githubWebhookRoute } from "./routes/github-webhook.js";
import { notionSyncRoute } from "./routes/notion-sync.js";
import { notionDelegateRoute } from "./routes/notion-delegate.js";
import type { FitbitAuth, GitSyncResult, NotionTask, DelegationResult } from "@cherryagent/tools";

interface ServerDeps {
  fitbitAuth?: FitbitAuth;
  githubWebhook?: {
    repoMap: Map<string, string>;
    webhookSecret: string;
    onConflict?: (repoPath: string, result: GitSyncResult) => void;
  };
  notionSync?: {
    onError?: (project: string, error: Error) => void;
  };
  notionDelegate?: {
    onStart?: (task: NotionTask) => void;
    onComplete?: (result: DelegationResult) => void;
    onError?: (task: NotionTask, error: Error) => void;
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

  if (deps?.notionSync) {
    await app.register(notionSyncRoute(deps.notionSync));
  }

  if (deps?.notionDelegate) {
    await app.register(notionDelegateRoute(deps.notionDelegate));
  }

  return app;
}
