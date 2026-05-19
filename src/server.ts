import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[nutriverde-backend] listening on http://localhost:${env.PORT}`);
  console.log(`[nutriverde-backend] env: ${env.NODE_ENV}`);
});

async function shutdown(signal: string) {
  console.log(`\n[nutriverde-backend] received ${signal}, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
