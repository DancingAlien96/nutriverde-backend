import { z } from "zod";
import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { isValidSlot } from "./scheduling.js";
import { HttpError } from "../middlewares/error-handler.js";

/**
 * Link de la videollamada. Solo https: el valor se guarda y luego se
 * renderiza como <a href> en el panel y en el correo, así que un
 * "javascript:" o "data:" sería un XSS almacenado que cualquier cuenta
 * del panel (incluida la secretaria) podría plantar para quien lo abra.
 */
export const meetingUrlSchema = z
  .string()
  .trim()
  .url("El link de la videollamada es obligatorio y debe ser una URL válida.")
  .refine(
    (u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "El link de la videollamada debe empezar con https://" },
  );

/** Zona horaria IANA válida (ej. America/Guatemala). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidTimezone, { message: "Zona horaria no válida." });

/**
 * Confirmación de una cita: fija el horario, guarda el link de la
 * videollamada, la marca SCHEDULED y le manda a la paciente el correo con
 * fecha + enlace.
 *
 * Vive aquí (y no en una ruta) porque se dispara desde dos lugares: el
 * detalle del pago (nutricionista) y la agenda (secretaria). Ambos deben
 * comportarse igual.
 */
export interface ConfirmAppointmentInput {
  appointmentId: string;
  meetingUrl: string;
  meetingProvider?: "GOOGLE_MEET" | "ZOOM";
  /** Opcional: fija o ajusta el horario. Si falta, se usa el ya propuesto. */
  scheduledAt?: Date;
}

export async function confirmAppointment(input: ConfirmAppointmentInput) {
  const appt = await prisma.appointment.findUnique({
    where: { id: input.appointmentId },
    include: { patient: true, service: true, payment: true },
  });
  if (!appt) throw new HttpError(404, "Cita no encontrada.");

  // Sin pago aprobado no se agenda nada. Las citas creadas sin pago (payment
  // null) no existen en el flujo actual, pero el chequeo cubre ambos casos.
  if (appt.payment ? appt.payment.status !== "APPROVED" : appt.status === "AWAITING_PAYMENT") {
    throw new HttpError(409, "Primero debe aprobarse el pago de esta cita.");
  }
  if (appt.status === "CANCELED" || appt.status === "NO_SHOW" || appt.status === "COMPLETED") {
    throw new HttpError(409, "Esta cita ya no se puede agendar.");
  }

  const when = input.scheduledAt ?? appt.scheduledAt;
  if (!when) {
    throw new HttpError(
      400,
      "No hay un horario para confirmar. Elige una fecha y hora o pide a la paciente que proponga una.",
    );
  }

  // Revalidamos el slot (excluyendo esta misma cita): otra cita pudo haberse
  // confirmado en el mismo hueco mientras tanto.
  const slotOk = await isValidSlot(when, appt.durationMin, appt.id);
  if (!slotOk) {
    throw new HttpError(
      409,
      "Ese horario ya no está disponible. Elige otro o pide a la paciente que proponga uno nuevo.",
    );
  }

  const updated = await prisma.appointment.update({
    where: { id: appt.id },
    data: {
      scheduledAt: when,
      status: "SCHEDULED",
      meetingUrl: input.meetingUrl,
      meetingProvider: input.meetingProvider ?? "GOOGLE_MEET",
    },
  });

  void sendMail({
    to: appt.patient.email,
    subject: "Cita confirmada — Plenha Nutrition",
    template: "appointment-confirmed",
    html: appointmentConfirmedHtml({
      name: appt.patient.fullName,
      service: appt.service.name,
      when,
      durationMin: appt.durationMin,
      patientTimezone: appt.patient.timezone,
      meetingUrl: input.meetingUrl,
    }),
  }).catch((err) => console.error("Email confirmación falló:", err));

  return updated;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Confirmación final de la cita con el enlace de la videollamada. */
export function appointmentConfirmedHtml(opts: {
  name: string;
  service: string;
  when: Date;
  durationMin: number;
  patientTimezone: string;
  meetingUrl: string;
}): string {
  const gtTime = opts.when.toLocaleString("es-GT", {
    timeZone: "America/Guatemala",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const localTime = opts.when.toLocaleString("es-GT", {
    timeZone: opts.patientTimezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameTz = opts.patientTimezone === "America/Guatemala";
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #687445; font-size: 22px;">¡Tu cita está confirmada, ${escapeHtml(opts.name)}!</h1>
      <p><strong>Servicio:</strong> ${escapeHtml(opts.service)} (${opts.durationMin} min)</p>
      <p><strong>Fecha y hora (Guatemala):</strong> ${escapeHtml(gtTime)}</p>
      ${sameTz ? "" : `<p><strong>En tu zona horaria:</strong> ${escapeHtml(localTime)}</p>`}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(opts.meetingUrl)}" style="display: inline-block; background: #687445; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 999px; font-weight: 500;">
          Unirme a la videollamada
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copia este enlace:<br/>${escapeHtml(opts.meetingUrl)}</p>
      <p style="margin-top: 24px;">Si necesitas reprogramar, responde a este correo.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}

/** Correo de cancelación: fecha tachada, motivo opcional, invitación a reagendar. */
export function appointmentCanceledHtml(opts: {
  name: string;
  service: string;
  when: Date;
  patientTimezone: string;
  reason: string | null;
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
      <p>Tu cita de <strong>${escapeHtml(opts.service)}</strong> quedó cancelada:</p>
      <p style="background: #f3f4f6; border-radius: 8px; padding: 12px 16px; color: #6b7280; text-decoration: line-through;">${escapeHtml(localTime)}</p>
      ${opts.reason ? `<p><strong>Motivo:</strong> ${escapeHtml(opts.reason)}</p>` : ""}
      <p>Si quieres reprogramarla, responde este correo o escríbenos y te buscamos un nuevo horario.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}

/** Correo de reprogramación: fecha anterior tachada, nueva fecha y enlace. */
export function appointmentRescheduledHtml(opts: {
  name: string;
  service: string;
  previous: Date | null;
  when: Date;
  durationMin: number;
  patientTimezone: string;
  meetingUrl: string | null;
}): string {
  const fmt = (d: Date, tz: string) =>
    d.toLocaleString("es-GT", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const sameTz = opts.patientTimezone === "America/Guatemala";
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #687445; font-size: 22px;">Tu cita cambió de horario, ${escapeHtml(opts.name)}</h1>
      <p><strong>Servicio:</strong> ${escapeHtml(opts.service)} (${opts.durationMin} min)</p>
      ${
        opts.previous
          ? `<p style="color: #6b7280; text-decoration: line-through;">${escapeHtml(fmt(opts.previous, "America/Guatemala"))}</p>`
          : ""
      }
      <p><strong>Nueva fecha y hora (Guatemala):</strong> ${escapeHtml(fmt(opts.when, "America/Guatemala"))}</p>
      ${sameTz ? "" : `<p><strong>En tu zona horaria:</strong> ${escapeHtml(fmt(opts.when, opts.patientTimezone))}</p>`}
      ${
        opts.meetingUrl
          ? `<p style="margin: 24px 0;">
        <a href="${escapeHtml(opts.meetingUrl)}" style="display: inline-block; background: #687445; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 999px; font-weight: 500;">
          Unirme a la videollamada
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copia este enlace:<br/>${escapeHtml(opts.meetingUrl)}</p>`
          : `<p>Te enviaremos el enlace de la videollamada antes de la cita.</p>`
      }
      <p style="margin-top: 24px;">Si el nuevo horario no te funciona, responde a este correo.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}
