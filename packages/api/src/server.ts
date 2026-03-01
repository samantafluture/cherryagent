import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { fitbitCallbackRoute } from "./routes/fitbit-callback.js";
import type { FitbitAuth } from "@cherryagent/tools";

export async function createServer(deps?: { fitbitAuth?: FitbitAuth }) {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  });

  await app.register(healthRoutes);

  if (deps?.fitbitAuth) {
    await app.register(fitbitCallbackRoute(deps.fitbitAuth));
  }

  return app;
}
