import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../../middlewares/require-admin.js";

const router = Router();
router.use(requireAdmin);

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// Lista las citas con horario asignado (para el calendario del admin).
// Opcionalmente filtra por rango [from, to].
router.get("/", async (req, res, next) => {
  try {
    const { from, to } = querySchema.parse(req.query);

    const scheduledAt: {
      not: null;
      gte?: Date;
      lte?: Date;
    } = { not: null };
    if (from) scheduledAt.gte = new Date(from);
    if (to) scheduledAt.lte = new Date(to);

    const appointments = await prisma.appointment.findMany({
      where: { scheduledAt },
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true,
        scheduledAt: true,
        durationMin: true,
        timezone: true,
        status: true,
        meetingUrl: true,
        meetingProvider: true,
        notes: true,
        patient: {
          select: { id: true, fullName: true, email: true, phone: true },
        },
        service: { select: { id: true, name: true } },
        payment: {
          select: {
            id: true,
            status: true,
            amountCents: true,
            currency: true,
          },
        },
      },
    });

    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

export default router;
