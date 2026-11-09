import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin, requireFullAccess } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";
import {
  amountCentsSchema,
  chargeInclude,
  chargeMethodSchema,
  chargePlanSchema,
  createChargeTx,
  fmtMoney,
  initialPaidCents,
  notifyChargeActivity,
  summarizeCharge,
} from "../../lib/charges.js";

/**
 * Cobros del panel: precio acordado de una cita suelta o de un paquete, y
 * los abonos que se van recibiendo.
 *
 * Permisos: cualquier rol del panel puede ver el cobro, crearlo y registrar
 * abonos (la secretaria es quien cobra en recepción). Cambiar el precio ya
 * acordado o borrar un abono es solo de nutricionista/staff.
 */
const router = Router();
router.use(requireAdmin);

const noteSchema = z
  .string()
  .trim()
  .max(300)
  .refine(isUtf8, utf8Message("La nota"))
  .optional()
  .or(z.literal(""));

/**
 * Saldos pendientes: cobros a los que les falta dinero. No cuenta la cita
 * suelta cancelada (ya no se debe). Ordenados por antigüedad.
 */
router.get("/outstanding", async (_req, res, next) => {
  try {
    const rows = await prisma.charge.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        ...chargeInclude,
        patient: { select: { id: true, fullName: true, email: true, phone: true } },
        service: { select: { name: true } },
        appointment: { select: { status: true, scheduledAt: true } },
        package: { select: { totalSessions: true } },
      },
    });

    const charges = rows
      .filter((r) => r.appointment?.status !== "CANCELED")
      .map((r) => ({
        ...summarizeCharge(r),
        patient: r.patient,
        serviceName: r.service.name,
        totalSessions: r.package?.totalSessions ?? null,
        appointmentAt: r.appointment?.scheduledAt ?? null,
      }))
      .filter((c) => c.balanceCents > 0);

    res.json({
      charges,
      // Solo quetzales en el total: no se mezclan monedas.
      totalCents: charges
        .filter((c) => c.currency === "GTQ")
        .reduce((sum, c) => sum + c.balanceCents, 0),
    });
  } catch (err) {
    next(err);
  }
});

const createSchema = z
  .object({
    appointmentId: z.string().trim().min(1).optional(),
    packageId: z.string().trim().min(1).optional(),
    // Sin precio se usa el de lista del servicio.
    priceCents: amountCentsSchema.optional(),
    plan: chargePlanSchema.optional(),
    paidCents: amountCentsSchema.optional(),
    method: chargeMethodSchema.default("CASH"),
    notes: noteSchema,
  })
  .refine((v) => !!v.appointmentId !== !!v.packageId, {
    message: "Indica una cita o un paquete (solo uno).",
    path: ["appointmentId"],
  });

/**
 * Registra el cobro de una cita o paquete que ya existía sin él (por
 * ejemplo, lo agendado antes de que hubiera cobros). Las citas nuevas lo
 * crean directo en POST /admin/appointments.
 */
router.post("/", async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);

    let target: {
      patientId: string;
      serviceId: string;
      listPriceCents: number;
      currency: string;
    };

    if (input.packageId) {
      const pkg = await prisma.sessionPackage.findUnique({
        where: { id: input.packageId },
        include: { service: { select: { priceCents: true, currency: true } }, charge: { select: { id: true } } },
      });
      if (!pkg) throw new HttpError(404, "Paquete no encontrado.");
      if (pkg.paymentId) {
        throw new HttpError(409, "Este paquete ya se pagó con comprobante desde la web.");
      }
      if (pkg.charge) throw new HttpError(409, "Este paquete ya tiene un cobro registrado.");
      target = {
        patientId: pkg.patientId,
        serviceId: pkg.serviceId,
        listPriceCents: pkg.service.priceCents,
        currency: pkg.service.currency,
      };
    } else {
      const appt = await prisma.appointment.findUnique({
        where: { id: input.appointmentId! },
        include: {
          service: { select: { priceCents: true, currency: true } },
          payment: { select: { id: true } },
          charge: { select: { id: true } },
        },
      });
      if (!appt) throw new HttpError(404, "Cita no encontrada.");
      if (appt.packageId) {
        throw new HttpError(409, "Esta cita es parte de un paquete: el cobro se registra en el paquete.");
      }
      if (appt.payment) {
        throw new HttpError(409, "Esta cita ya se pagó con comprobante desde la web.");
      }
      if (appt.charge) throw new HttpError(409, "Esta cita ya tiene un cobro registrado.");
      target = {
        patientId: appt.patientId,
        serviceId: appt.serviceId,
        listPriceCents: appt.service.priceCents,
        currency: appt.service.currency,
      };
    }

    const priceCents = input.priceCents ?? target.listPriceCents;
    const paidCents = initialPaidCents(priceCents, input.plan, input.paidCents);
    if (paidCents > priceCents) {
      throw new HttpError(400, "El abono no puede ser mayor que el precio.");
    }

    let charge;
    try {
      charge = await prisma.$transaction((tx) =>
        createChargeTx(tx, {
          patientId: target.patientId,
          serviceId: target.serviceId,
          packageId: input.packageId ?? null,
          appointmentId: input.appointmentId ?? null,
          priceCents,
          listPriceCents: target.listPriceCents,
          currency: target.currency,
          plan: input.plan ?? "FULL",
          paidCents,
          method: input.method,
          notes: input.notes || null,
          actorEmail: req.admin!.email,
        }),
      );
    } catch (err) {
      // Dos personas registrando el mismo cobro a la vez: gana la primera.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "Ya hay un cobro registrado.");
      }
      throw err;
    }

    void notifyChargeActivity({ actor: req.admin!, chargeId: charge.id });
    res.status(201).json({ ok: true, charge });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const row = await prisma.charge.findUnique({
      where: { id: req.params.id },
      include: chargeInclude,
    });
    if (!row) throw new HttpError(404, "Cobro no encontrado.");
    res.json({ charge: summarizeCharge(row) });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  priceCents: amountCentsSchema.optional(),
  plan: chargePlanSchema.optional(),
  notes: noteSchema,
});

/**
 * Corrige el precio acordado, la forma de pago o la nota. Solo
 * nutricionista/staff: quien cobra no puede bajarse el precio a sí misma.
 * El precio no puede quedar por debajo de lo ya abonado.
 */
router.patch("/:id", requireFullAccess, async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);

    const charge = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM charges WHERE id = ${req.params.id} FOR UPDATE`;
      if (locked.length === 0) throw new HttpError(404, "Cobro no encontrado.");
      const current = await tx.charge.findUniqueOrThrow({
        where: { id: req.params.id },
        include: chargeInclude,
      });
      const paid = summarizeCharge(current).paidCents;
      if (input.priceCents !== undefined && input.priceCents < paid) {
        throw new HttpError(
          409,
          `El precio no puede ser menor que lo ya abonado (${fmtMoney(paid, current.currency)}).`,
        );
      }
      const updated = await tx.charge.update({
        where: { id: current.id },
        data: {
          priceCents: input.priceCents,
          plan: input.plan,
          notes: input.notes === undefined ? undefined : input.notes || null,
        },
        include: chargeInclude,
      });
      return summarizeCharge(updated);
    });

    res.json({ ok: true, charge });
  } catch (err) {
    next(err);
  }
});

const paymentSchema = z.object({
  amountCents: amountCentsSchema.refine((v) => v > 0, "El abono debe ser mayor que cero"),
  method: chargeMethodSchema.default("CASH"),
  // Fecha en que se recibió el dinero; por defecto, ahora.
  paidAt: z.string().datetime().optional(),
  note: noteSchema,
});

/**
 * Registra un abono. La fila del cobro se bloquea para que dos abonos casi
 * simultáneos no pasen del saldo.
 */
router.post("/:id/payments", async (req, res, next) => {
  try {
    const input = paymentSchema.parse(req.body);
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + 24 * 60 * 60_000) {
      throw new HttpError(400, "La fecha del abono no puede ser futura.");
    }

    const charge = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM charges WHERE id = ${req.params.id} FOR UPDATE`;
      if (locked.length === 0) throw new HttpError(404, "Cobro no encontrado.");
      const current = await tx.charge.findUniqueOrThrow({
        where: { id: req.params.id },
        include: chargeInclude,
      });
      const { balanceCents } = summarizeCharge(current);
      if (balanceCents === 0) throw new HttpError(409, "Este cobro ya está pagado por completo.");
      if (input.amountCents > balanceCents) {
        throw new HttpError(
          409,
          `El abono supera el saldo pendiente (${fmtMoney(balanceCents, current.currency)}).`,
        );
      }
      await tx.chargePayment.create({
        data: {
          chargeId: current.id,
          amountCents: input.amountCents,
          method: input.method,
          paidAt,
          note: input.note || null,
          recordedByEmail: req.admin!.email,
        },
      });
      const updated = await tx.charge.findUniqueOrThrow({
        where: { id: current.id },
        include: chargeInclude,
      });
      return summarizeCharge(updated);
    });

    void notifyChargeActivity({
      actor: req.admin!,
      chargeId: charge.id,
      payment: { amountCents: input.amountCents, method: input.method },
    });
    res.status(201).json({ ok: true, charge });
  } catch (err) {
    next(err);
  }
});

/** Borra un abono registrado por error. Solo nutricionista/staff. */
router.delete("/:id/payments/:paymentId", requireFullAccess, async (req, res, next) => {
  try {
    const payment = await prisma.chargePayment.findUnique({
      where: { id: req.params.paymentId },
      select: { id: true, chargeId: true },
    });
    if (!payment || payment.chargeId !== req.params.id) {
      throw new HttpError(404, "Abono no encontrado.");
    }
    await prisma.chargePayment.delete({ where: { id: payment.id } });
    const row = await prisma.charge.findUniqueOrThrow({
      where: { id: req.params.id },
      include: chargeInclude,
    });
    res.json({ ok: true, charge: summarizeCharge(row) });
  } catch (err) {
    next(err);
  }
});

export default router;
