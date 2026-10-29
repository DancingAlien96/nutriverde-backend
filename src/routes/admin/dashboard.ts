import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../../middlewares/require-admin.js";

/**
 * Datos agregados para el inicio del panel (solo nutricionista/staff; el
 * router se monta detrás de requireFullAccess). Todo se calcula aquí para
 * que el frontend no tenga que bajar todos los pagos y citas.
 *
 * Los meses se cortan en hora de Guatemala (UTC-6, sin horario de verano),
 * igual que el resto del sistema.
 */
const router = Router();
router.use(requireAdmin);

const GT_OFFSET_MS = 6 * 60 * 60_000;

/** Clave YYYY-MM del mes de Guatemala al que pertenece un instante. */
function monthKey(d: Date): string {
  const local = new Date(d.getTime() - GT_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Instante UTC del inicio (00:00 GT) del mes `offset` meses antes del actual. */
function monthStart(now: Date, offset: number): Date {
  const local = new Date(now.getTime() - GT_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - offset, 1, GT_OFFSET_MS / 3_600_000),
  );
}

const querySchema = z.object({
  months: z.coerce.number().int().min(3).max(24).default(12),
});

router.get("/", async (req, res, next) => {
  try {
    const { months } = querySchema.parse(req.query);
    const now = new Date();
    const windowStart = monthStart(now, months - 1);
    const thisMonthStart = monthStart(now, 0);
    const lastMonthStart = monthStart(now, 1);
    const nextMonthStart = monthStart(now, -1);

    // Claves de los meses de la ventana, del más antiguo al actual.
    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i--) keys.push(monthKey(monthStart(now, i)));

    const [approvedPayments, monthPayments, appointments, patientsTotal, newPatients, pendingReview, packages, upcoming, recentPatients] =
      await Promise.all([
        prisma.payment.findMany({
          where: { status: "APPROVED", approvedAt: { gte: windowStart } },
          select: {
            amountCents: true,
            currency: true,
            approvedAt: true,
            service: { select: { name: true } },
          },
        }),
        prisma.payment.findMany({
          where: { createdAt: { gte: thisMonthStart } },
          select: { status: true, amountCents: true, currency: true },
        }),
        prisma.appointment.findMany({
          where: { scheduledAt: { gte: windowStart, lt: nextMonthStart } },
          select: { status: true, scheduledAt: true },
        }),
        prisma.patient.count(),
        prisma.patient.count({ where: { createdAt: { gte: thisMonthStart } } }),
        prisma.payment.count({ where: { status: "PENDING_REVIEW" } }),
        prisma.sessionPackage.findMany({
          select: {
            totalSessions: true,
            appointments: { where: { status: { not: "CANCELED" } }, select: { id: true } },
          },
        }),
        prisma.appointment.findMany({
          where: {
            scheduledAt: { gte: now },
            status: { in: ["SCHEDULED", "PENDING_CONFIRMATION"] },
          },
          orderBy: { scheduledAt: "asc" },
          take: 5,
          select: {
            id: true,
            scheduledAt: true,
            status: true,
            patient: { select: { fullName: true } },
            service: { select: { name: true } },
          },
        }),
        prisma.patient.findMany({
          orderBy: { createdAt: "desc" },
          take: 4,
          select: { id: true, fullName: true, email: true, createdAt: true },
        }),
      ]);

    // ---- Ingresos por mes (GTQ y USD por separado: no se mezclan monedas) ----
    const income = new Map(keys.map((k) => [k, { gtqCents: 0, usdCents: 0, count: 0 }]));
    const byService = new Map<string, { gtqCents: number; count: number }>();
    let incomeThisMonth = 0;
    let incomeLastMonth = 0;
    for (const p of approvedPayments) {
      if (!p.approvedAt) continue;
      const bucket = income.get(monthKey(p.approvedAt));
      if (bucket) {
        if (p.currency === "USD") bucket.usdCents += p.amountCents;
        else bucket.gtqCents += p.amountCents;
        bucket.count += 1;
      }
      if (p.currency !== "USD") {
        if (p.approvedAt >= thisMonthStart) incomeThisMonth += p.amountCents;
        else if (p.approvedAt >= lastMonthStart) incomeLastMonth += p.amountCents;
        const s = byService.get(p.service.name) ?? { gtqCents: 0, count: 0 };
        s.gtqCents += p.amountCents;
        s.count += 1;
        byService.set(p.service.name, s);
      }
    }

    // Top 6 servicios + "Otros", para no pasar de ~7 clases en la gráfica.
    const services = Array.from(byService.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.gtqCents - a.gtqCents);
    const topServices = services.slice(0, 6);
    const rest = services.slice(6);
    if (rest.length > 0) {
      topServices.push({
        name: "__other__",
        gtqCents: rest.reduce((a, s) => a + s.gtqCents, 0),
        count: rest.reduce((a, s) => a + s.count, 0),
      });
    }

    // ---- Citas por mes: realizadas / programadas / canceladas ----
    const appts = new Map(keys.map((k) => [k, { done: 0, upcoming: 0, canceled: 0 }]));
    let appointmentsThisMonth = 0;
    for (const a of appointments) {
      if (!a.scheduledAt) continue;
      const bucket = appts.get(monthKey(a.scheduledAt));
      if (!bucket) continue;
      if (a.status === "CANCELED" || a.status === "NO_SHOW") bucket.canceled += 1;
      else if (a.status === "COMPLETED" || (a.status === "SCHEDULED" && a.scheduledAt < now))
        bucket.done += 1;
      else bucket.upcoming += 1;
      if (a.scheduledAt >= thisMonthStart && a.status !== "CANCELED") appointmentsThisMonth += 1;
    }

    // ---- Pagos recibidos este mes por estado (GTQ) ----
    const paymentsThisMonth = { approved: 0, pending: 0, rejected: 0, approvedCents: 0, pendingCents: 0, rejectedCents: 0 };
    for (const p of monthPayments) {
      const cents = p.currency === "USD" ? 0 : p.amountCents;
      if (p.status === "APPROVED") {
        paymentsThisMonth.approved += 1;
        paymentsThisMonth.approvedCents += cents;
      } else if (p.status === "PENDING_REVIEW") {
        paymentsThisMonth.pending += 1;
        paymentsThisMonth.pendingCents += cents;
      } else {
        paymentsThisMonth.rejected += 1;
        paymentsThisMonth.rejectedCents += cents;
      }
    }

    // ---- Paquetes activos y sesiones por agendar ----
    let activePackages = 0;
    let sessionsRemaining = 0;
    for (const p of packages) {
      const left = p.totalSessions - p.appointments.length;
      if (left > 0) {
        activePackages += 1;
        sessionsRemaining += left;
      }
    }

    res.json({
      generatedAt: now,
      months: keys,
      kpis: {
        incomeThisMonthCents: incomeThisMonth,
        incomeLastMonthCents: incomeLastMonth,
        appointmentsThisMonth,
        patientsTotal,
        newPatientsThisMonth: newPatients,
        pendingReview,
        activePackages,
        sessionsRemaining,
      },
      incomeByMonth: keys.map((k) => ({ month: k, ...income.get(k)! })),
      appointmentsByMonth: keys.map((k) => ({ month: k, ...appts.get(k)! })),
      revenueByService: topServices,
      paymentsThisMonth,
      upcoming,
      recentPatients,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
