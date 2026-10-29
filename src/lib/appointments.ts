import { z } from "zod";
import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { isValidSlot } from "./scheduling.js";
import { env } from "../config/env.js";
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
  .refine(
    (u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message:
        "El enlace de la videollamada no es válido: pega la dirección completa de Meet o Zoom (empieza con https://) o déjalo vacío.",
    },
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
  /** Opcional: si falta se conserva el que ya tenía la cita (o ninguno). */
  meetingUrl?: string | null;
  meetingProvider?: "GOOGLE_MEET" | "ZOOM";
  /** Opcional: fija o ajusta el horario. Si falta, se usa el ya propuesto. */
  scheduledAt?: Date;
}

/** Resultado del envío de un correo, para enseñárselo a quien agendó. */
export interface EmailOutcome {
  to: string;
  sent: boolean;
  error?: string;
}

/**
 * Envía y devuelve el resultado en vez de lanzar: el correo es importante
 * pero no debe deshacer una cita ya guardada. El detalle queda en email_logs.
 */
export async function trySendMail(
  options: Parameters<typeof sendMail>[0],
): Promise<EmailOutcome> {
  try {
    await sendMail(options);
    return { to: options.to, sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Email "${options.template}" a ${options.to} falló:`, message);
    return { to: options.to, sent: false, error: message };
  }
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

  // Sin enlace nuevo se conserva el anterior; si tampoco había, la cita
  // queda confirmada sin enlace y el correo avisa que se enviará después.
  const meetingUrl = input.meetingUrl || appt.meetingUrl || null;
  const updated = await prisma.appointment.update({
    where: { id: appt.id },
    data: {
      scheduledAt: when,
      status: "SCHEDULED",
      meetingUrl,
      meetingProvider: meetingUrl ? input.meetingProvider ?? appt.meetingProvider ?? "GOOGLE_MEET" : null,
    },
  });

  // Se espera el envío para poder decirle a quien agendó si el correo salió.
  const email = await trySendMail({
    to: appt.patient.email,
    subject: "Cita confirmada — Plenha Nutrition",
    template: "appointment-confirmed",
    html: appointmentConfirmedHtml({
      name: appt.patient.fullName,
      service: appt.service.name,
      when,
      durationMin: appt.durationMin,
      patientTimezone: appt.patient.timezone,
      meetingUrl,
    }),
  });

  return { appointment: updated, email };
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
  meetingUrl: string | null;
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
      ${
        opts.meetingUrl
          ? `<p style="margin: 24px 0;">
        <a href="${escapeHtml(opts.meetingUrl)}" style="display: inline-block; background: #687445; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 999px; font-weight: 500;">
          Unirme a la videollamada
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copia este enlace:<br/>${escapeHtml(opts.meetingUrl)}</p>`
          : `<p style="margin: 24px 0;">Te enviaremos el enlace de la videollamada antes de la cita.</p>`
      }
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

// ============================================================
// Aviso interno a la nutricionista cuando otra persona (la secretaria o
// el staff) mueve la agenda: crear, confirmar, rechazar horario, cancelar
// o reprogramar. Si quien actúa es nutricionista no se avisa a sí misma.
// ============================================================

export type StaffAction = "created" | "confirmed" | "declined" | "canceled" | "rescheduled";

const ACTION_LABEL: Record<StaffAction, string> = {
  created: "agendó una cita nueva",
  confirmed: "confirmó una cita",
  declined: "rechazó el horario de una cita",
  canceled: "canceló una cita",
  rescheduled: "reprogramó una cita",
};

export async function notifyNutritionists(opts: {
  actor: { sub: string; email: string; role: string };
  action: StaffAction;
  appointmentId: string;
  reason?: string | null;
  previous?: Date | null;
}): Promise<void> {
  if (opts.actor.role === "NUTRITIONIST") return;
  // Se llama con `void`: nada de aquí puede escapar como rechazo sin manejar.
  try {
    await notifyNutritionistsUnsafe(opts);
  } catch (err) {
    console.error("Aviso a nutricionista falló:", err);
  }
}

async function notifyNutritionistsUnsafe(opts: {
  actor: { sub: string; email: string; role: string };
  action: StaffAction;
  appointmentId: string;
  reason?: string | null;
  previous?: Date | null;
}): Promise<void> {
  const [appt, actor, recipients] = await Promise.all([
    prisma.appointment.findUnique({
      where: { id: opts.appointmentId },
      include: {
        patient: { select: { fullName: true, email: true, phone: true } },
        service: { select: { name: true } },
      },
    }),
    prisma.adminUser.findUnique({
      where: { id: opts.actor.sub },
      select: { fullName: true, email: true },
    }),
    prisma.adminUser.findMany({
      where: { active: true, role: "NUTRITIONIST", id: { not: opts.actor.sub } },
      select: { email: true },
    }),
  ]);
  if (!appt || recipients.length === 0) return;

  const actorName = actor?.fullName ?? opts.actor.email;
  const subject = `${actorName} ${ACTION_LABEL[opts.action]}: ${appt.patient.fullName}`;
  const html = staffNoticeHtml({
    actorName,
    actionLabel: ACTION_LABEL[opts.action],
    patientName: appt.patient.fullName,
    patientEmail: appt.patient.email,
    patientPhone: appt.patient.phone,
    service: appt.service.name,
    when: appt.scheduledAt,
    previous: opts.previous ?? null,
    meetingUrl: appt.meetingUrl,
    reason: opts.reason ?? null,
    panelUrl: `${env.PUBLIC_BASE_URL}/admin/citas`,
  });

  await Promise.all(
    recipients.map((r) =>
      sendMail({ to: r.email, subject, template: "appointment-staff-notice", html }).catch(
        (err) => console.error("Aviso a nutricionista falló:", err),
      ),
    ),
  );
}

function fmtGtLong(d: Date): string {
  return d.toLocaleString("es-GT", {
    timeZone: "America/Guatemala",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function staffNoticeHtml(opts: {
  actorName: string;
  actionLabel: string;
  patientName: string;
  patientEmail: string;
  patientPhone: string | null;
  service: string;
  when: Date | null;
  previous: Date | null;
  meetingUrl: string | null;
  reason: string | null;
  panelUrl: string;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h2 style="color: #687445; font-size: 20px;">${escapeHtml(opts.actorName)} ${escapeHtml(opts.actionLabel)}</h2>
      <ul style="line-height: 1.8; padding-left: 18px;">
        <li><strong>Paciente:</strong> ${escapeHtml(opts.patientName)} (${escapeHtml(opts.patientEmail)}${opts.patientPhone ? `, ${escapeHtml(opts.patientPhone)}` : ""})</li>
        <li><strong>Servicio:</strong> ${escapeHtml(opts.service)}</li>
        ${opts.previous ? `<li><strong>Horario anterior:</strong> <span style="text-decoration: line-through;">${escapeHtml(fmtGtLong(opts.previous))}</span></li>` : ""}
        ${opts.when ? `<li><strong>Fecha y hora (Guatemala):</strong> ${escapeHtml(fmtGtLong(opts.when))}</li>` : "<li><strong>Fecha y hora:</strong> pendiente</li>"}
        ${opts.meetingUrl ? `<li><strong>Enlace:</strong> ${escapeHtml(opts.meetingUrl)}</li>` : "<li><strong>Enlace:</strong> aún sin enlace</li>"}
        ${opts.reason ? `<li><strong>Motivo:</strong> ${escapeHtml(opts.reason)}</li>` : ""}
      </ul>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(opts.panelUrl)}" style="display: inline-block; background: #687445; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 999px; font-weight: 500;">Ver la agenda</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Aviso automático del panel de Plenha Nutrition.</p>
    </div>
  `;
}
