import type { FastifyPluginAsync } from "fastify";
import {
  processDelegatedTasks,
  executeDelegatedTask,
  type DelegationResult,
  type NotionTask,
} from "@cherryagent/tools";

interface DelegateDeps {
  onStart?: (task: NotionTask) => void;
  onComplete?: (result: DelegationResult) => void;
  onError?: (task: NotionTask, error: Error) => void;
}

export function notionDelegateRoute(deps: DelegateDeps): FastifyPluginAsync {
  return async (app) => {
    // Manually trigger delegation check for all pending tasks
    app.post("/api/notion/delegate", async (request, reply) => {
      request.log.info("[delegate] Manual trigger — checking for delegated tasks");

      const results = await processDelegatedTasks(deps);

      const completed = results.filter((r) => r.action === "completed").length;
      const failed = results.filter((r) => r.action === "failed").length;
      const skipped = results.filter((r) => r.action === "skipped").length;

      return reply.status(200).send({
        status: "ok",
        completed,
        failed,
        skipped,
        results,
      });
    });
  };
}
