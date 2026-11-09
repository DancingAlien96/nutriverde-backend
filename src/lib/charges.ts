import type { ChargeMethod, ChargePlan, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { env } from "../config/env.js";

/**
 * Cobros del panel. Un cobro (Charge) es el precio acordado de una cita
 * suelta o de un paquete agendado a mano; los abonos (ChargePayment) son lo
 * que la paciente va pagando. El saldo y el estado se calculan siempre a
 * partir de los abonos: no hay nada que mantener sincronizado.
 */

export type ChargeStatus = "PAID" | "PARTIAL" | "PENDING";

export interface ChargePaymentView {
  id: string;
  amountCents: number;
  method: ChargeMethod;
  paidAt: Date;
  note: string | null;
  recordedByEmail: string | null;
}

export interface ChargeSummary {
  id: string;
  /** PACKAGE: cobra todo el paquete. APPOINTMENT: cobra una cita suelta. */
  scope: "PACKAGE" | "APPOINTMENT";
  packageId: string | null;
  appointmentId: string | null;
  priceCents: number;
  listPriceCents: number;
  currency: string;
  plan: ChargePlan;
  paidCents: number;
  balanceCents: number;
  status: ChargeStatus;
  notes: string | null;
  createdAt: Date;
  payments: ChargePaymentView[];
}

export const chargeInclude = {
  payments: { orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.ChargeInclude;

type ChargeRow = Prisma.ChargeGetPayload<{ include: typeof chargeInclude }>;

/** Tope por monto: Q100,000. Evita ceros de más por error de dedo. */
export const MAX_AMOUNT_CENTS = 10_000_000;

export const amountCentsSchema = z
  .number({ invalid_type_error: "Monto inválido" })
  .int("Monto inválido")
  .min(0, "El monto no puede ser negativo")
  .max(MAX_AMOUNT_CENTS, "Monto demasiado alto");

export const chargeMethodSchema = z.enum(["CASH", "TRANSFER", "CARD", "OTHER"]);
export const chargePlanSchema = z.enum(["FULL", "INSTALLMENTS"]);

export function chargeStatus(priceCents: number, paidCents: number): ChargeStatus {
  if (paidCents >= priceCents) return "PAID";
  return paidCents > 0 ? "PARTIAL" : "PENDING";
}

export function summarizeCharge(c: ChargeRow): ChargeSummary {
  const paidCents = c.payments.reduce((sum, p) => sum + p.amountCents, 0);
  return {
    id: c.id,
    scope: c.packageId ? "PACKAGE" : "APPOINTMENT",
    packageId: c.packageId,
    appointmentId: c.appointmentId,
    priceCents: c.priceCents,
    listPriceCents: c.listPriceCents,
    currency: c.currency,
    plan: c.plan,
    paidCents,
    balanceCents: Math.max(0, c.priceCents - paidCents),
    status: chargeStatus(c.priceCents, paidCents),
    notes: c.notes,
    createdAt: c.createdAt,
    payments: c.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      method: p.method,
      paidAt: p.paidAt,
      note: p.note,
      recordedByEmail: p.recordedByEmail,
    })),
  };
}

/**
 * Cobro que aplica a cada cita: el suyo si es suelta, o el de su paquete.
 * Una sola consulta por lote (para el calendario).
 */
export async function chargesForAppointments(
  appointments: { id: string; packageId: string | null }[],
): Promise<Map<string, ChargeSummary>> {
  const result = new Map<string, ChargeSummary>();
  if (appointments.length === 0) return result;
  const packageIds = Array.from(
    new Set(appointments.map((a) => a.packageId).filter((x): x is string => !!x)),
  );
  const rows = await prisma.charge.findMany({
    where: {
      OR: [
        { appointmentId: { in: appointments.map((a) => a.id) } },
        ...(packageIds.length ? [{ packageId: { in: packageIds } }] : []),
      ],
    },
    include: chargeInclude,
  });
  const byAppointment = new Map<string, ChargeSummary>();
  const byPackage = new Map<string, ChargeSummary>();
  for (const row of rows) {
    const summary = summarizeCharge(row);
    if (row.appointmentId) byAppointment.set(row.appointmentId, summary);
    if (row.packageId) byPackage.set(row.packageId, summary);
  }
  for (const a of appointments) {
    const own = byAppointment.get(a.id) ?? (a.packageId ? byPackage.get(a.packageId) : undefined);
    if (own) result.set(a.id, own);
  }
  return result;
}

/** Cobros de los paquetes indicados, por id de paquete. */
export async function chargesForPackages(packageIds: string[]): Promise<Map<string, ChargeSummary>> {
  const result = new Map<string, ChargeSummary>();
  if (packageIds.length === 0) return result;
  const rows = await prisma.charge.findMany({
    where: { packageId: { in: packageIds } },
    include: chargeInclude,
  });
  for (const row of rows) if (row.packageId) result.set(row.packageId, summarizeCharge(row));
  return result;
}

/**
 * Crea el cobro dentro de una transacción, con su primer abono si lo hay.
 * `paidCents` ya debe venir validado (0 <= paidCents <= priceCents).
 */
export async function createChargeTx(
  tx: Prisma.TransactionClient,
  opts: {
    patientId: string;
    serviceId: string;
    packageId?: string | null;
    appointmentId?: string | null;
    priceCents: number;
    listPriceCents: number;
    currency: string;
    plan: ChargePlan;
    paidCents: number;
    method: ChargeMethod;
    notes?: string | null;
    actorEmail: string;
  },
): Promise<ChargeSummary> {
  const charge = await tx.charge.create({
    data: {
      patientId: opts.patientId,
      serviceId: opts.serviceId,
      packageId: opts.packageId ?? null,
      appointmentId: opts.appointmentId ?? null,
      priceCents: opts.priceCents,
      listPriceCents: opts.listPriceCents,
      currency: opts.currency,
      plan: opts.plan,
      notes: opts.notes ?? null,
      createdByEmail: opts.actorEmail,
      payments:
        opts.paidCents > 0
          ? {
              create: {
                amountCents: opts.paidCents,
                method: opts.method,
                recordedByEmail: opts.actorEmail,
              },
            }
          : undefined,
    },
    include: chargeInclude,
  });
  return summarizeCharge(charge);
}

/**
 * Cuánto se abona al crear el cobro según la forma de pago:
 * FULL = se cobró completo; INSTALLMENTS = abona `paidCents` (puede ser 0).
 * Sin `plan` no se registra ningún abono (cobro pendiente).
 */
export function initialPaidCents(
  priceCents: number,
  plan: ChargePlan | undefined,
  paidCents: number | undefined,
): number {
  if (!plan) return 0;
  if (plan === "FULL") return priceCents;
  return paidCents ?? 0;
}

export function fmtMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const text = amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  if (currency === "GTQ") return `Q${text}`;
  if (currency === "USD") return `US$${text}`;
  return `${currency} ${text}`;
}

const METHOD_LABEL: Record<ChargeMethod, string> = {
  CASH: "efectivo",
  TRANSFER: "transferencia",
  CARD: "tarjeta",
  OTHER: "otro medio",
};

/** Línea de cobro para los avisos internos: precio, pagado y saldo. */
export function chargeLine(c: ChargeSummary): string {
  let price = `Precio ${fmtMoney(c.priceCents, c.currency)}`;
  if (c.priceCents !== c.listPriceCents) {
    price += ` (lista ${fmtMoney(c.listPriceCents, c.currency)})`;
  }
  return [
    price,
    c.plan === "INSTALLMENTS" ? "por plazos" : "pago único",
    `pagado ${fmtMoney(c.paidCents, c.currency)}`,
    c.balanceCents > 0 ? `saldo ${fmtMoney(c.balanceCents, c.currency)}` : "sin saldo",
  ].join(" · ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Aviso a la nutricionista cuando alguien más registra un abono o un cobro.
 * Se llama con `void`: nunca debe escapar un rechazo sin manejar.
 */
export async function notifyChargeActivity(opts: {
  actor: { sub: string; email: string; role: string };
  chargeId: string;
  /** Abono recién registrado; sin él, el aviso es por un cobro nuevo. */
  payment?: { amountCents: number; method: ChargeMethod };
}): Promise<void> {
  if (opts.actor.role === "NUTRITIONIST") return;
  try {
    const [row, actor, recipients] = await Promise.all([
      prisma.charge.findUnique({
        where: { id: opts.chargeId },
        include: {
          ...chargeInclude,
          patient: { select: { fullName: true, email: true } },
          service: { select: { name: true } },
        },
      }),
      prisma.adminUser.findUnique({
        where: { id: opts.actor.sub },
        select: { fullName: true },
      }),
      prisma.adminUser.findMany({
        where: { active: true, role: "NUTRITIONIST", id: { not: opts.actor.sub } },
        select: { email: true },
      }),
    ]);
    if (!row || recipients.length === 0) return;

    const charge = summarizeCharge(row);
    const actorName = actor?.fullName ?? opts.actor.email;
    const what = opts.payment
      ? `registró un abono de ${fmtMoney(opts.payment.amountCents, charge.currency)} (${METHOD_LABEL[opts.payment.method]})`
      : "registró un cobro";
    const subject = `${actorName} ${what}: ${row.patient.fullName}`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
        <h2 style="color: #687445; font-size: 20px;">${escapeHtml(actorName)} ${escapeHtml(what)}</h2>
        <ul style="line-height: 1.8; padding-left: 18px;">
          <li><strong>Paciente:</strong> ${escapeHtml(row.patient.fullName)} (${escapeHtml(row.patient.email)})</li>
          <li><strong>Concepto:</strong> ${escapeHtml(row.service.name)}${charge.scope === "PACKAGE" ? " (paquete)" : ""}</li>
          <li><strong>Cobro:</strong> ${escapeHtml(chargeLine(charge))}</li>
        </ul>
        <p style="margin: 24px 0;">
          <a href="${escapeHtml(`${env.PUBLIC_BASE_URL}/admin/citas`)}" style="display: inline-block; background: #687445; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 999px; font-weight: 500;">Ver la agenda</a>
        </p>
        <p style="color: #6b7280; font-size: 13px;">Aviso automático del panel de Plenha Nutrition.</p>
      </div>
    `;
    await Promise.all(
      recipients.map((r) =>
        sendMail({ to: r.email, subject, template: "charge-staff-notice", html }).catch((err) =>
          console.error("Aviso de cobro falló:", err),
        ),
      ),
    );
  } catch (err) {
    console.error("Aviso de cobro falló:", err);
  }
}
