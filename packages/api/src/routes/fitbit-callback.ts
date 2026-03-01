import type { FastifyInstance } from "fastify";
import type { FitbitAuth } from "@cherryagent/tools";

export function fitbitCallbackRoute(fitbitAuth: FitbitAuth) {
  return async function (app: FastifyInstance) {
    app.get("/api/fitbit/callback", async (req, reply) => {
      const { code } = req.query as { code?: string };

      if (!code) {
        return reply.status(400).send("Missing authorization code.");
      }

      try {
        await fitbitAuth.exchangeCode(code);
        return reply.send(
          "Fitbit connected! You can close this tab.",
        );
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Unknown error";
        req.log.error({ err }, "Fitbit OAuth callback failed");
        return reply.status(500).send(`Fitbit auth failed: ${msg}`);
      }
    });
  };
}
