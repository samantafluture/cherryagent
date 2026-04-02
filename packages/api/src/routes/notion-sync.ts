import type { FastifyPluginAsync } from "fastify";
import { syncProject, syncAllProjects, type SyncResult } from "@cherryagent/tools";

interface NotionSyncDeps {
  onError?: (project: string, error: Error) => void;
}

export function notionSyncRoute(deps: NotionSyncDeps): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Body: Record<string, unknown> }>("/api/notion/sync", async (request, reply) => {
      const body = request.body ?? {};

      // Try to extract project name from webhook payload
      // Notion automation webhooks have varying shapes — be lenient
      const project = extractProjectFromPayload(body);

      let results: SyncResult[];

      if (project) {
        request.log.info(`[notion-sync] Webhook triggered for project: ${project}`);
        const result = await syncProject(project);
        if (result.action === "error" && deps.onError) {
          deps.onError(result.project, new Error(result.message));
        }
        results = [result];
      } else {
        request.log.info("[notion-sync] Webhook triggered — full sync (no project detected)");
        results = await syncAllProjects();
        for (const r of results) {
          if (r.action === "error" && deps.onError) {
            deps.onError(r.project, new Error(r.message));
          }
        }
      }

      const synced = results.filter((r) => r.action === "synced").length;
      const skipped = results.filter((r) => r.action === "skipped").length;
      const errors = results.filter((r) => r.action === "error").length;

      return reply.status(200).send({
        status: "ok",
        synced,
        skipped,
        errors,
        results,
      });
    });
  };
}

/**
 * Best-effort extraction of project name from a Notion webhook payload.
 * Returns undefined if we can't determine the project.
 */
function extractProjectFromPayload(body: Record<string, unknown>): string | undefined {
  // Notion automation webhooks may include data.properties or similar
  // Try common shapes
  if (typeof body === "object" && body !== null) {
    // Direct project field
    if (typeof body["project"] === "string") return body["project"];

    // Nested under data
    const data = body["data"] as Record<string, unknown> | undefined;
    if (data && typeof data["project"] === "string") return data["project"];

    // Properties object with Project select
    const properties = (data?.["properties"] ?? body["properties"]) as Record<string, unknown> | undefined;
    if (properties) {
      const proj = properties["Project"] as Record<string, unknown> | undefined;
      if (proj?.["select"]) {
        const sel = proj["select"] as Record<string, unknown>;
        if (typeof sel["name"] === "string") return sel["name"];
      }
    }
  }

  return undefined;
}
