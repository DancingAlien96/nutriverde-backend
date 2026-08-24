import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { sendMail } from "../../lib/mailer.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

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


const declineSchema = z.object({
  // Motivo opcional que se le muestra a la paciente. Sin esto solo recibiria
  // un "no puedo" sin contexto, que se siente peor que un rechazo explicado.
  reason: z
    .string()
    .trim()
    .max(500)
    .refine(isUtf8, utf8Message("El motivo"))
    .optional()
    .or(z.literal("")),
});

/**
 * La nutricionista no puede atender el horario que la paciente eligio.
 *
 * Devuelve la cita al estado "pago aprobado, falta horario" y le reenvia el
 * link de auto-agenda. Reutiliza el scheduleToken que ya existe para que el
 * enlace no cambie; si la cita ya estaba confirmada y no tiene token (caso de
 * las creadas antes de este flujo), se genera uno.
 *
 * No toca el pago: el dinero sigue acreditado y la consulta sigue viva, solo
 * se mueve la fecha.
 */
router.post("/:id/decline-time", async (req, res, next) => {
  try {
    const { reason } = declineSchema.parse(req.body);

    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true, payment: true },
    });
    if (!appt) throw new HttpError(404, "Cita no encontrada.");

    if (!appt.scheduledAt) {
      throw new HttpError(
        409,
        "Esta cita todavía no tiene horario que rechazar.",
      );
    }
    if (appt.status !== "PENDING_CONFIRMATION" && appt.status !== "SCHEDULED") {
      throw new HttpError(
        409,
        "Solo se puede rechazar el horario de una cita propuesta o ya agendada.",
      );
    }
    if (appt.payment && appt.payment.status !== "APPROVED") {
      throw new HttpError(
        409,
        "El pago de esta cita no está aprobado; no hay horario que reprogramar.",
      );
    }

    const scheduleToken =
      appt.scheduleToken ?? crypto.randomBytes(24).toString("hex");
    const rejectedWhen = appt.scheduledAt;

    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        // Se limpia el horario para que el slot vuelva a quedar libre para
        // otras pacientes mientras esta elige uno nuevo.
        scheduledAt: null,
        status: "PAYMENT_APPROVED",
        scheduleToken,
        // El link de la reunion pertenecia al horario descartado.
        meetingUrl: null,
        meetingProvider: null,
      },
    });

    void sendMail({
      to: appt.patient.email,
      subject: "Necesitamos reprogramar tu cita — Plenha Nutrition",
      template: "appointment-time-declined",
      html: timeDeclinedHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        when: rejectedWhen,
        patientTimezone: appt.patient.timezone,
        reason: reason || null,
        scheduleUrl: `${env.PUBLIC_BASE_URL}/agendar-cita/${scheduleToken}`,
      }),
    }).catch((err) => console.error("Email de reprogramación falló:", err));

    res.json({ ok: true, appointment: updated });
  } catch (err) {
    next(err);
  }
});

function timeDeclinedHtml(opts: {
  name: string;
  service: string;
  when: Date;
  patientTimezone: string;
  reason: string | null;
  scheduleUrl: string;
}): string {
  const localTime = opts.when.toLocaleString("es-GT", {
    timeZone: opts.patientTimezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #687445; font-size: 22px;">Hola ${escapeHtml(opts.name)},</h1>
      <p>Lamentamos avisarte que no podremos atenderte en el horario que elegiste para tu <strong>${escapeHtml(opts.service)}</strong>:</p>
      <p style="background: #f3f4f6; border-radius: 8px; padding: 12px 16px; color: #6b7280; text-decoration: line-through;">${escapeHtml(localTime)}</p>
      ${
        opts.reason
          ? `<p><strong>Motivo:</strong> ${escapeHtml(opts.reason)}</p>`
          : ""
      }
      <p><strong>Tu pago sigue confirmado</strong> y tu consulta está reservada. Solo necesitamos que elijas otro horario:</p>
      <p style="margin: 24px 0;">
        <a href="${opts.scheduleUrl}" style="background: #687445; color: #ffffff; padding: 12px 24px; border-radius: 999px; text-decoration: none; display: inline-block;">Elegir otro horario</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Si ninguno de los horarios disponibles te funciona, responde este correo y lo resolvemos.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default router;
