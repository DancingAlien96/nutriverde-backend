import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sendMail } from "../lib/mailer.js";
import { HttpError } from "../middlewares/error-handler.js";
import {
  getAvailableSlots,
  getCandidateDates,
  getMonthlyAvailability,
  isValidSlot,
} from "../lib/scheduling.js";

const router = Router();

async function loadAppointmentByToken(token: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { scheduleToken: token },
    include: {
      patient: { select: { id: true, fullName: true, email: true, timezone: true } },
      service: { select: { id: true, name: true, slug: true, durationMin: true } },
    },
  });
  if (!appointment) throw new HttpError(404, "Link inválido o expirado.");
  return appointment;
}

router.get("/:token", async (req, res, next) => {
  try {
    const appt = await loadAppointmentByToken(req.params.token);

    res.json({
      appointment: {
        id: appt.id,
        status: appt.status,
        scheduledAt: appt.scheduledAt,
        durationMin: appt.durationMin,
        timezone: appt.timezone,
      },
      patient: appt.patient,
      service: appt.service,
      candidateDates: await getCandidateDates(30),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:token/availability", async (req, res, next) => {
  try {
    const appt = await loadAppointmentByToken(req.params.token);
    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/, "Formato esperado YYYY-MM")
      .parse(req.query.month);

    const data = await getMonthlyAvailability(month, appt.durationMin, appt.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/:token/slots", async (req, res, next) => {
  try {
    const appt = await loadAppointmentByToken(req.params.token);

    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado YYYY-MM-DD")
      .parse(req.query.date);

    const slots = await getAvailableSlots({
      date,
      durationMin: appt.durationMin,
      excludeAppointmentId: appt.id,
    });

    res.json({
      date,
      durationMin: appt.durationMin,
      slots: slots.map((s) => s.toISOString()),
    });
  } catch (err) {
    next(err);
  }
});

const confirmSchema = z.object({
  startAt: z.string().datetime(),
});

router.post("/:token/confirm", async (req, res, next) => {
  try {
    const appt = await loadAppointmentByToken(req.params.token);

    if (appt.status === "AWAITING_PAYMENT") {
      throw new HttpError(409, "El pago aún no ha sido aprobado.");
    }
    if (appt.status === "CANCELED" || appt.status === "NO_SHOW") {
      throw new HttpError(409, "Esta cita ya no se puede agendar.");
    }

    const { startAt } = confirmSchema.parse(req.body);
    const scheduledAt = new Date(startAt);

    const ok = await isValidSlot(scheduledAt, appt.durationMin, appt.id);
    if (!ok) {
      throw new HttpError(409, "Ese horario ya no está disponible. Elige otro.");
    }

    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        scheduledAt,
        status: "SCHEDULED",
      },
    });

    void sendMail({
      to: appt.patient.email,
      subject: "Cita confirmada — NutriVerde",
      template: "appointment-confirmed",
      html: confirmationHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        when: scheduledAt,
        durationMin: appt.durationMin,
        meetingUrl: updated.meetingUrl,
        patientTimezone: appt.patient.timezone,
      }),
    }).catch((err) => console.error("Email confirmación falló:", err));

    res.json({
      ok: true,
      appointment: {
        id: updated.id,
        status: updated.status,
        scheduledAt: updated.scheduledAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function confirmationHtml(opts: {
  name: string;
  service: string;
  when: Date;
  durationMin: number;
  meetingUrl: string | null;
  patientTimezone: string;
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

  const meetingBlock = opts.meetingUrl
    ? `<p><strong>Link de la consulta:</strong> <a href="${escapeHtml(opts.meetingUrl)}">${escapeHtml(opts.meetingUrl)}</a></p>`
    : `<p>Te enviaremos el link de la videollamada antes de tu cita.</p>`;

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #059669; font-size: 22px;">¡Tu cita está confirmada, ${escapeHtml(opts.name)}!</h1>
      <p><strong>Servicio:</strong> ${escapeHtml(opts.service)} (${opts.durationMin} min)</p>
      <p><strong>Fecha y hora (Guatemala):</strong> ${escapeHtml(gtTime)}</p>
      <p><strong>En tu zona horaria:</strong> ${escapeHtml(localTime)}</p>
      ${meetingBlock}
      <p style="margin-top: 24px;">Si necesitas reprogramar, responde a este correo y lo coordinamos.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— NutriVerde</p>
    </div>
  `;
}

export default router;
