import type { FastifyInstance } from "fastify";
import type { FitbitAuth } from "@cherryagent/tools";
import { getFitbitHealthSummary } from "@cherryagent/tools";

const INTERNAL_TOKEN = process.env["INTERNAL_API_TOKEN"] ?? "";

export function fitbitHealthSummaryRoute(
  fitbitAuth: FitbitAuth,
  timezone: string,
) {
  return async function (app: FastifyInstance) {
    app.get("/api/fitbit/health-summary", async (req, reply) => {
      const token = req.headers["x-internal-token"];
      if (!INTERNAL_TOKEN || token !== INTERNAL_TOKEN) {
        return reply.status(401).send({ error: "unauthorized" });
      }

      const { date = "today" } = req.query as { date?: string };

      try {
        const summary = await getFitbitHealthSummary(fitbitAuth, date, timezone);
        return reply.send(summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";

        if (
          message.includes("not authorized") ||
          message.includes("authorization expired")
        ) {
          return reply
            .status(503)
            .send({ error: "fitbit_unauthorized", detail: message });
        }

        req.log.error({ err }, "Fitbit health summary failed");
        return reply.status(500).send({ error: "internal_error", detail: message });
      }
    });
  };
}
