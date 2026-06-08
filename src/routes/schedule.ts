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

    // El horario que elige el paciente queda como PROPUESTA: la cita pasa a
    // PENDING_CONFIRMATION. La nutricionista debe aceptarla y agregar el link
    // de la videollamada; recién ahí se vuelve SCHEDULED y el paciente recibe
    // el correo con el enlace.
    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        scheduledAt,
        status: "PENDING_CONFIRMATION",
      },
    });

    // Aviso al paciente: recibimos tu horario, falta confirmación.
    void sendMail({
      to: appt.patient.email,
      subject: "Recibimos tu horario — Plenha Nutrition",
      template: "appointment-proposed",
      html: proposedHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        when: scheduledAt,
        durationMin: appt.durationMin,
        patientTimezone: appt.patient.timezone,
      }),
    }).catch((err) => console.error("Email propuesta falló:", err));

    // Notificación a la nutricionista para que confirme.
    const admin = await prisma.adminUser.findFirst({
      where: { active: true, role: "NUTRITIONIST" },
      select: { email: true },
    });
    if (admin) {
      void sendMail({
        to: admin.email,
        subject: `Horario propuesto: ${appt.patient.fullName}`,
        template: "appointment-proposed-admin",
        html: adminProposedHtml({
          patientName: appt.patient.fullName,
          service: appt.service.name,
          when: scheduledAt,
        }),
      }).catch((err) => console.error("Email admin propuesta falló:", err));
    }

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

function fmtGt(when: Date): string {
  return when.toLocaleString("es-GT", {
    timeZone: "America/Guatemala",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Correo al paciente: recibimos tu horario, falta confirmación de la nutricionista. */
function proposedHtml(opts: {
  name: string;
  service: string;
  when: Date;
  durationMin: number;
  patientTimezone: string;
}): string {
  const gtTime = fmtGt(opts.when);
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
      <h1 style="color: #687445; font-size: 22px;">Recibimos tu horario, ${escapeHtml(opts.name)}</h1>
      <p>Solicitaste <strong>${escapeHtml(opts.service)}</strong> (${opts.durationMin} min) para:</p>
      <p><strong>Fecha y hora (Guatemala):</strong> ${escapeHtml(gtTime)}</p>
      ${sameTz ? "" : `<p><strong>En tu zona horaria:</strong> ${escapeHtml(localTime)}</p>`}
      <p style="margin-top: 16px;">Estamos confirmando la disponibilidad. En breve te enviaremos un correo con la
      confirmación final y el <strong>enlace de la videollamada</strong>.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}

/** Correo a la nutricionista: hay un horario propuesto para confirmar. */
function adminProposedHtml(opts: {
  patientName: string;
  service: string;
  when: Date;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h2>Horario propuesto por un paciente</h2>
      <ul style="line-height: 1.8;">
        <li><strong>Paciente:</strong> ${escapeHtml(opts.patientName)}</li>
        <li><strong>Servicio:</strong> ${escapeHtml(opts.service)}</li>
        <li><strong>Fecha propuesta:</strong> ${escapeHtml(fmtGt(opts.when))}</li>
      </ul>
      <p>Entra al panel para aceptar la cita y enviar el enlace de la videollamada.</p>
    </div>
  `;
}

export default router;
