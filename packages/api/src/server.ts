import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

export async function createServer() {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  });

  await app.register(healthRoutes);

  return app;
}
