import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  getAvailableSlots,
  getCandidateDates,
  getMonthlyAvailability,
} from "../lib/scheduling.js";
import { HttpError } from "../middlewares/error-handler.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const services = await prisma.service.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        nameEn: true,
        nameEs: true,
        descriptionEn: true,
        descriptionEs: true,
        imageUrl: true,
        priceCents: true,
        currency: true,
        durationMin: true,
        billingType: true,
      },
    });

    res.json({
      services: services.map((s) => ({
        ...s,
        priceFormatted: formatPrice(s.priceCents, s.currency),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Slots disponibles para un servicio en una fecha (hora Guatemala).
 * Público: lo consume el formulario /agendar para que el paciente pueda
 * elegir un horario tentativo antes de subir el comprobante.
 */
router.get("/:slug/slots", async (req, res, next) => {
  try {
    const service = await prisma.service.findUnique({
      where: { slug: req.params.slug },
      select: { active: true, durationMin: true },
    });
    if (!service || !service.active) {
      throw new HttpError(404, "Servicio no disponible.");
    }

    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado YYYY-MM-DD")
      .parse(req.query.date);

    const slots = await getAvailableSlots({
      date,
      durationMin: service.durationMin,
    });

    res.json({
      date,
      durationMin: service.durationMin,
      slots: slots.map((s) => s.toISOString()),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Disponibilidad agregada del mes: para cada fecha (que sea día laboral) devuelve
 * AVAILABLE / FULL / BLOCKED. Lo consume el calendario del frontend.
 */
router.get("/:slug/availability", async (req, res, next) => {
  try {
    const service = await prisma.service.findUnique({
      where: { slug: req.params.slug },
      select: { active: true, durationMin: true },
    });
    if (!service || !service.active) {
      throw new HttpError(404, "Servicio no disponible.");
    }

    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/, "Formato esperado YYYY-MM")
      .parse(req.query.month);

    const data = await getMonthlyAvailability(month, service.durationMin);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/:slug/candidate-dates", async (req, res, next) => {
  try {
    const service = await prisma.service.findUnique({
      where: { slug: req.params.slug },
      select: { active: true },
    });
    if (!service || !service.active) {
      throw new HttpError(404, "Servicio no disponible.");
    }
    const dates = await getCandidateDates(30);
    res.json({ candidateDates: dates });
  } catch (err) {
    next(err);
  }
});

function formatPrice(cents: number, currency: string): string {
  const amount = cents / 100;
  if (currency === "GTQ") {
    return `Q${amount.toFixed(0)}`;
  }
  return `${currency} ${amount.toFixed(2)}`;
}

export default router;
