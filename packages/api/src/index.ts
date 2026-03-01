import { createServer } from "./server.js";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

async function main() {
  const server = await createServer();

  await server.listen({ port: PORT, host: HOST });
  console.log(`CherryAgent API listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
