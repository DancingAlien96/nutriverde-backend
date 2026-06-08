import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

const router = Router();
router.use(requireAdmin);

const minuteSchema = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);

const slotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: minuteSchema,
    endMinute: minuteSchema,
    active: z.boolean().optional(),
  })
  .refine((d) => d.startMinute < d.endMinute, {
    message: "startMinute debe ser menor que endMinute",
  });

router.get("/", async (_req, res, next) => {
  try {
    const [slots, blocks, settings] = await Promise.all([
      prisma.availabilitySlot.findMany({
        orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
      }),
      prisma.availabilityBlock.findMany({
        where: { endsAt: { gte: new Date() } },
        orderBy: { startsAt: "asc" },
      }),
      prisma.schedulingSettings.upsert({
        where: { id: "default" },
        update: {},
        create: { id: "default" },
      }),
    ]);
    res.json({ slots, blocks, settings });
  } catch (err) {
    next(err);
  }
});

const settingsSchema = z.object({
  allowSameDayBooking: z.boolean().optional(),
  minLeadMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
});

router.put("/settings", async (req, res, next) => {
  try {
    const patch = settingsSchema.parse(req.body);
    const settings = await prisma.schedulingSettings.upsert({
      where: { id: "default" },
      update: patch,
      create: { id: "default", ...patch },
    });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

router.post("/slots", async (req, res, next) => {
  try {
    const data = slotSchema.parse(req.body);
    await assertNoOverlap(data.dayOfWeek, data.startMinute, data.endMinute);
    const slot = await prisma.availabilitySlot.create({
      data: { ...data, active: data.active ?? true },
    });
    res.status(201).json({ slot });
  } catch (err) {
    next(err);
  }
});

const slotUpdateSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    startMinute: minuteSchema.optional(),
    endMinute: minuteSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.startMinute === undefined ||
      d.endMinute === undefined ||
      d.startMinute < d.endMinute,
    { message: "startMinute debe ser menor que endMinute" },
  );

router.put("/slots/:id", async (req, res, next) => {
  try {
    const patch = slotUpdateSchema.parse(req.body);
    const existing = await prisma.availabilitySlot.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw new HttpError(404, "Slot no encontrado.");

    const merged = { ...existing, ...patch };
    if (merged.startMinute >= merged.endMinute) {
      throw new HttpError(400, "startMinute debe ser menor que endMinute.");
    }
    await assertNoOverlap(
      merged.dayOfWeek,
      merged.startMinute,
      merged.endMinute,
      existing.id,
    );

    const slot = await prisma.availabilitySlot.update({
      where: { id: req.params.id },
      data: patch,
    });
    res.json({ slot });
  } catch (err) {
    next(err);
  }
});

router.delete("/slots/:id", async (req, res, next) => {
  try {
    await prisma.availabilitySlot.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const blockSchema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    reason: z
      .string()
      .trim()
      .max(200)
      .refine(isUtf8, utf8Message("La razón"))
      .optional()
      .or(z.literal("")),
  })
  .refine((d) => new Date(d.startsAt) < new Date(d.endsAt), {
    message: "startsAt debe ser anterior a endsAt",
  });

router.post("/blocks", async (req, res, next) => {
  try {
    const data = blockSchema.parse(req.body);
    const block = await prisma.availabilityBlock.create({
      data: {
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        reason: data.reason || null,
      },
    });
    res.status(201).json({ block });
  } catch (err) {
    next(err);
  }
});

router.delete("/blocks/:id", async (req, res, next) => {
  try {
    await prisma.availabilityBlock.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

async function assertNoOverlap(
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
  excludeId?: string,
): Promise<void> {
  const overlapping = await prisma.availabilitySlot.findFirst({
    where: {
      dayOfWeek,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startMinute: { lt: endMinute },
      endMinute: { gt: startMinute },
    },
    select: { id: true, startMinute: true, endMinute: true },
  });
  if (overlapping) {
    throw new HttpError(
      409,
      `El rango se traslapa con otro existente (${fmt(overlapping.startMinute)}–${fmt(overlapping.endMinute)}).`,
    );
  }
}

function fmt(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export default router;
