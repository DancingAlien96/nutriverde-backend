import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { buildExpedientePdf } from "../../lib/expediente-pdf.js";
import {
  DOCUMENT_TYPES,
  normalizeDocument,
  validateDocument,
} from "../../lib/document-id.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

const router = Router();
router.use(requireAdmin);

const listQuerySchema = z.object({
  q: z.string().trim().optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const { q } = listQuerySchema.parse(req.query);

    const where = q
      ? {
          OR: [
            { fullName: { contains: q } },
            { email: { contains: q } },
            { documentId: { contains: q } },
            { phone: { contains: q } },
          ],
        }
      : undefined;

    const patients = await prisma.patient.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        fullName: true,
        email: true,
        documentId: true,
        documentType: true,
        phone: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            appointments: true,
            payments: true,
            nutritionPlans: true,
          },
        },
      },
    });

    res.json({ patients });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      include: {
        intakeForms: {
          orderBy: { submittedAt: "desc" },
        },
        appointments: {
          orderBy: { createdAt: "desc" },
          include: {
            service: { select: { id: true, name: true, slug: true } },
            payment: {
              select: {
                id: true,
                status: true,
                amountCents: true,
                currency: true,
                approvedAt: true,
                rejectedReason: true,
              },
            },
            nutritionPlan: {
              select: {
                id: true,
                title: true,
                fileUrl: true,
                sentAt: true,
              },
            },
          },
        },
        payments: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            amountCents: true,
            currency: true,
            receiptUrl: true,
            receiptMime: true,
            createdAt: true,
            approvedAt: true,
            rejectedReason: true,
            service: { select: { name: true } },
            appointmentId: true,
          },
        },
        nutritionPlans: {
          orderBy: { createdAt: "desc" },
        },
        diagnoses: {
          orderBy: { createdAt: "desc" },
        },
        trainings: {
          orderBy: { createdAt: "desc" },
        },
        measurements: {
          orderBy: { measuredAt: "desc" },
        },
        mealPlans: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!patient) throw new HttpError(404, "Paciente no encontrado.");

    // Estadísticas rápidas
    const stats = {
      totalAppointments: patient.appointments.length,
      completedAppointments: patient.appointments.filter(
        (a) => a.status === "COMPLETED",
      ).length,
      scheduledAppointments: patient.appointments.filter(
        (a) => a.status === "SCHEDULED",
      ).length,
      totalPaidCents: patient.payments
        .filter((p) => p.status === "APPROVED")
        .reduce((sum, p) => sum + p.amountCents, 0),
    };

    res.json({ patient, stats });
  } catch (err) {
    next(err);
  }
});

/** Helper: trim + null si quedó vacío + valida UTF-8. Para campos opcionales de texto. */
const nullableText = z
  .string()
  .trim()
  .max(5000)
  .refine(isUtf8, utf8Message("El texto"))
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v))
  .nullable();

const nullableShortText = z
  .string()
  .trim()
  .max(500)
  .refine(isUtf8, utf8Message("El texto"))
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v))
  .nullable();

const updateSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  documentId: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(6).max(30).optional().or(z.literal("")),
  whatsappNotify: z.boolean().optional(),
  notes: nullableText,
  referralSource: nullableShortText,

  // Datos clínicos estáticos
  birthDate: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((v) => (v ? new Date(v) : v)),
  heightCm: z.number().int().min(50).max(250).optional().nullable(),
  allergies: nullableText,
  medicalConditions: nullableText,
  medications: nullableText,
  alcoholNotes: nullableShortText,
  cravingsNotes: nullableShortText,
  waterCoffeeNotes: nullableShortText,
  dislikedFoods: nullableText,
  weekendSpots: nullableText,
});

router.put("/:id", async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    const existing = await prisma.patient.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw new HttpError(404, "Paciente no encontrado.");

    // Si vienen documentType y/o documentId, normalizamos y validamos.
    let normalizedDoc: string | undefined;
    if (patch.documentId !== undefined || patch.documentType !== undefined) {
      const type = patch.documentType ?? existing.documentType;
      const rawId = patch.documentId ?? existing.documentId ?? "";
      normalizedDoc = normalizeDocument(rawId, type);
      const check = validateDocument(type, normalizedDoc);
      if (!check.ok) throw new HttpError(400, check.message);
    }

    const patient = await prisma.patient.update({
      where: { id: req.params.id },
      data: {
        ...patch,
        documentId: normalizedDoc ?? patch.documentId,
        phone: patch.phone === "" ? null : patch.phone,
      },
    });
    res.json({ patient });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Historial clínico (entradas que se acumulan)
// ============================================================

const diagnosisSchema = z.object({
  objective: nullableText,
  goalFatPercent: z.number().min(0).max(100).optional().nullable(),
  goalFatLossLbs: z.number().min(0).optional().nullable(),
  goalLeanMassKg: z.number().min(0).optional().nullable(),
  notes: nullableText,
});

router.post("/:id/diagnoses", async (req, res, next) => {
  try {
    const data = diagnosisSchema.parse(req.body);
    await assertPatientExists(req.params.id);
    const diagnosis = await prisma.patientDiagnosis.create({
      data: { ...data, patientId: req.params.id },
    });
    res.status(201).json({ diagnosis });
  } catch (err) {
    next(err);
  }
});

router.delete("/:patientId/diagnoses/:id", async (req, res, next) => {
  try {
    await prisma.patientDiagnosis.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const trainingSchema = z.object({
  duration: nullableShortText,
  frequency: nullableShortText,
  schedule: nullableText,
  notes: nullableText,
});

router.post("/:id/trainings", async (req, res, next) => {
  try {
    const data = trainingSchema.parse(req.body);
    await assertPatientExists(req.params.id);
    const training = await prisma.patientTraining.create({
      data: { ...data, patientId: req.params.id },
    });
    res.status(201).json({ training });
  } catch (err) {
    next(err);
  }
});

router.delete("/:patientId/trainings/:id", async (req, res, next) => {
  try {
    await prisma.patientTraining.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const measurementSchema = z.object({
  appointmentId: z.string().optional().nullable(),
  measuredAt: z.string().datetime().optional(),
  visitNumber: z.number().int().min(1).optional().nullable(),
  weightKg: z.number().min(0).optional().nullable(),
  fatPercent: z.number().min(0).max(100).optional().nullable(),
  waterPercent: z.number().min(0).max(100).optional().nullable(),
  leanMassKg: z.number().min(0).optional().nullable(),
  metabolicAge: z.number().int().min(0).optional().nullable(),
  visceralFat: z.number().int().min(0).optional().nullable(),
  caliperFatPercent: z.number().min(0).max(100).optional().nullable(),
  chestCm: z.number().min(0).optional().nullable(),
  waistCm: z.number().min(0).optional().nullable(),
  abdomenCm: z.number().min(0).optional().nullable(),
  hipCm: z.number().min(0).optional().nullable(),
  armCm: z.number().min(0).optional().nullable(),
  thighCm: z.number().min(0).optional().nullable(),
  calfCm: z.number().min(0).optional().nullable(),
  notes: nullableText,
});

router.post("/:id/measurements", async (req, res, next) => {
  try {
    const data = measurementSchema.parse(req.body);
    await assertPatientExists(req.params.id);
    const measurement = await prisma.anthropometricMeasurement.create({
      data: {
        ...data,
        patientId: req.params.id,
        measuredAt: data.measuredAt ? new Date(data.measuredAt) : undefined,
      },
    });
    res.status(201).json({ measurement });
  } catch (err) {
    next(err);
  }
});

router.put("/:patientId/measurements/:id", async (req, res, next) => {
  try {
    const data = measurementSchema.parse(req.body);
    const measurement = await prisma.anthropometricMeasurement.update({
      where: { id: req.params.id },
      data: {
        ...data,
        measuredAt: data.measuredAt ? new Date(data.measuredAt) : undefined,
      },
    });
    res.json({ measurement });
  } catch (err) {
    next(err);
  }
});

router.delete("/:patientId/measurements/:id", async (req, res, next) => {
  try {
    await prisma.anthropometricMeasurement.delete({
      where: { id: req.params.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const mealPlanSchema = z.object({
  title: nullableShortText,
  breakfast: nullableText,
  morningSnack: nullableText,
  lunch: nullableText,
  afternoonSnack: nullableText,
  dinner: nullableText,
  notes: nullableText,
});

router.post("/:id/meal-plans", async (req, res, next) => {
  try {
    const data = mealPlanSchema.parse(req.body);
    await assertPatientExists(req.params.id);
    const mealPlan = await prisma.mealPlan.create({
      data: { ...data, patientId: req.params.id },
    });
    res.status(201).json({ mealPlan });
  } catch (err) {
    next(err);
  }
});

router.delete("/:patientId/meal-plans/:id", async (req, res, next) => {
  try {
    await prisma.mealPlan.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PDF del expediente
// ============================================================

router.get("/:id/expediente.pdf", async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      include: {
        diagnoses: { orderBy: { createdAt: "desc" } },
        trainings: { orderBy: { createdAt: "desc" } },
        measurements: { orderBy: { measuredAt: "desc" } },
        mealPlans: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!patient) throw new HttpError(404, "Paciente no encontrado.");

    const safeName = patient.fullName.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="expediente-${safeName}.pdf"`,
    );

    buildExpedientePdf(
      {
        patient,
        diagnoses: patient.diagnoses,
        trainings: patient.trainings,
        measurements: patient.measurements,
        mealPlans: patient.mealPlans,
      },
      res,
    );
  } catch (err) {
    next(err);
  }
});

async function assertPatientExists(id: string): Promise<void> {
  const exists = await prisma.patient.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) throw new HttpError(404, "Paciente no encontrado.");
}

export default router;
