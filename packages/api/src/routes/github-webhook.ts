import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pullChanges, type GitSyncResult } from "@cherryagent/tools";

interface WebhookDeps {
  /** Map of GitHub repo full_name (e.g. "samantafluture/cherryagent") to local repo path */
  repoMap: Map<string, string>;
  webhookSecret: string;
  onConflict?: (repoPath: string, result: GitSyncResult) => void;
}

interface GithubPushPayload {
  ref: string;
  repository: { full_name: string };
  commits: Array<{
    modified: string[];
    added: string[];
    removed: string[];
  }>;
}

export function githubWebhookRoute(deps: WebhookDeps): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Body: GithubPushPayload }>("/api/github/webhook", {
      config: {
        rawBody: true,
      },
    }, async (request, reply) => {
      // Verify signature
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        return reply.status(401).send({ error: "Missing signature" });
      }

      const body = JSON.stringify(request.body);
      const expected = "sha256=" + createHmac("sha256", deps.webhookSecret)
        .update(body)
        .digest("hex");

      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return reply.status(401).send({ error: "Invalid signature" });
      }

      // Only handle push events to default branch
      const event = request.headers["x-github-event"];
      if (event !== "push") {
        return reply.status(200).send({ status: "ignored", reason: "not a push event" });
      }

      const payload = request.body;

      // Check if any commit touches .claude/tasks.md
      const touchesTasks = payload.commits.some((c) =>
        [...c.modified, ...c.added, ...c.removed].some((f) =>
          f === ".claude/tasks.md"
        )
      );

      if (!touchesTasks) {
        return reply.status(200).send({ status: "ignored", reason: "no task file changes" });
      }

      // Find the local repo path
      const repoFullName = payload.repository.full_name;
      const localPath = deps.repoMap.get(repoFullName);
      if (!localPath) {
        request.log.warn(`Webhook for unknown repo: ${repoFullName}`);
        return reply.status(200).send({ status: "ignored", reason: "repo not registered" });
      }

      // Pull changes
      try {
        const result = await pullChanges(localPath);
        if (result.action === "conflict" && deps.onConflict) {
          deps.onConflict(localPath, result);
        }
        return reply.status(200).send({ status: "ok", result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(`Webhook pull failed for ${repoFullName}: ${message}`);
        return reply.status(500).send({ status: "error", message });
      }
    });
  };
}
