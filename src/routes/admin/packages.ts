import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../../middlewares/require-admin.js";

/**
 * Vista global de paquetes para la nutricionista: cada paquete con su
 * paciente, sesiones usadas/restantes y el detalle de cada cita. Se monta
 * detrás de requireFullAccess.
 */
const router = Router();
router.use(requireAdmin);

router.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const packages = await prisma.sessionPackage.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        patient: { select: { id: true, fullName: true, email: true, phone: true } },
        service: { select: { id: true, name: true, internal: true } },
        payment: { select: { id: true, status: true, amountCents: true, currency: true } },
        appointments: {
          orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
          select: { id: true, scheduledAt: true, status: true, modality: true },
        },
      },
    });

    const items = packages.map((p) => {
      const live = p.appointments.filter((a) => a.status !== "CANCELED");
      const used = live.length;
      const remaining = Math.max(0, p.totalSessions - used);
      const done = live.filter(
        (a) => a.status === "COMPLETED" || (a.scheduledAt !== null && a.scheduledAt < now),
      ).length;
      const upcoming = live.filter((a) => a.scheduledAt !== null && a.scheduledAt >= now);
      const dated = live.filter((a) => a.scheduledAt !== null);
      let number = 0;
      const sessions = p.appointments.map((a) => {
        const counts = a.status !== "CANCELED";
        if (counts) number += 1;
        return {
          id: a.id,
          sessionNumber: counts ? number : null,
          scheduledAt: a.scheduledAt,
          status: a.status,
          modality: a.modality,
        };
      });
      return {
        id: p.id,
        createdAt: p.createdAt,
        notes: p.notes,
        patient: p.patient,
        service: p.service,
        payment: p.payment,
        totalSessions: p.totalSessions,
        usedSessions: used,
        remaining,
        doneSessions: done,
        // Citas asignadas pero todavía por realizar.
        scheduledPending: used - done,
        nextSessionAt: upcoming[0]?.scheduledAt ?? null,
        lastSessionAt: dated.length ? dated[dated.length - 1].scheduledAt : null,
        state: remaining > 0 ? "active" : done >= p.totalSessions ? "completed" : "exhausted",
        sessions,
      };
    });

    res.json({
      packages: items,
      summary: {
        active: items.filter((i) => i.state === "active").length,
        exhausted: items.filter((i) => i.state === "exhausted").length,
        completed: items.filter((i) => i.state === "completed").length,
        sessionsRemaining: items.reduce((a, i) => a + i.remaining, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
