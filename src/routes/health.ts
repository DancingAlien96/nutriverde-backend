import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "ok", time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      db: "error",
      error: err instanceof Error ? err.message : "unknown",
      time: new Date().toISOString(),
    });
  }
});

export default router;
