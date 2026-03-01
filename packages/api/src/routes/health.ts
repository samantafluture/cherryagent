import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_request, _reply) => {
    return {
      status: "ok",
      service: "cherryagent",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
};
