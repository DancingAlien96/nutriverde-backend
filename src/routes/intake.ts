import { Router } from "express";
import { z } from "zod";
import fs from "node:fs/promises";
import { prisma } from "../lib/prisma.js";
import { receiptUpload, toPublicUrl } from "../lib/upload.js";
import { sendMail } from "../lib/mailer.js";
import { env } from "../config/env.js";
import { HttpError } from "../middlewares/error-handler.js";
import { isValidSlot } from "../lib/scheduling.js";

const router = Router();

const intakeSchema = z.object({
  fullName: z.string().trim().min(2, "Nombre demasiado corto").max(120),
  email: z.string().trim().toLowerCase().email("Correo inválido"),
  phone: z.string().trim().min(6).max(30).optional().or(z.literal("")),
  whatsappNotify: z.union([z.boolean(), z.string()]).optional(),
  timezone: z.string().trim().default("America/Guatemala"),
  serviceSlug: z.string().trim().min(1, "Servicio requerido"),
  // Horario tentativo elegido por el paciente (ISO UTC). Si está, se valida
  // que sea un slot real al momento del intake. La validación final ocurre al
  // aprobar el pago (otro paciente pudo haber sido aprobado antes).
  scheduledAt: z.string().datetime().optional().or(z.literal("")),
  // Datos libres del formulario (objetivos, condiciones, etc.)
  goal: z.string().trim().max(2000).optional().or(z.literal("")),
  conditions: z.string().trim().max(2000).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "on", "yes"].includes(v.toLowerCase());
  return false;
}

router.post("/", receiptUpload.single("receipt"), async (req, res, next) => {
  let uploadedPath: string | null = req.file?.path ?? null;

  try {
    if (!req.file) {
      throw new HttpError(400, "Falta el comprobante de pago (campo 'receipt').");
    }

    const parsed = intakeSchema.parse(req.body);
    const whatsappNotify = coerceBool(parsed.whatsappNotify);

    const service = await prisma.service.findUnique({
      where: { slug: parsed.serviceSlug },
    });
    if (!service || !service.active) {
      throw new HttpError(400, "Servicio no disponible.");
    }

    // Si el paciente eligió un horario, validamos que sea un slot real ahora.
    // El conflicto definitivo se vuelve a chequear en el approve.
    let scheduledAt: Date | null = null;
    if (parsed.scheduledAt) {
      scheduledAt = new Date(parsed.scheduledAt);
      const ok = await isValidSlot(scheduledAt, service.durationMin);
      if (!ok) {
        throw new HttpError(
          409,
          "Ese horario ya no está disponible. Elige otro.",
        );
      }
    }

    const receiptUrl = toPublicUrl(req.file.path);

    const result = await prisma.$transaction(async (tx) => {
      const patient = await tx.patient.upsert({
        where: { email: parsed.email },
        update: {
          fullName: parsed.fullName,
          phone: parsed.phone || null,
          whatsappNotify,
          timezone: parsed.timezone,
        },
        create: {
          fullName: parsed.fullName,
          email: parsed.email,
          phone: parsed.phone || null,
          whatsappNotify,
          timezone: parsed.timezone,
        },
      });

      const intake = await tx.intakeForm.create({
        data: {
          patientId: patient.id,
          serviceSlug: parsed.serviceSlug,
          data: {
            goal: parsed.goal || null,
            conditions: parsed.conditions || null,
            notes: parsed.notes || null,
          },
        },
      });

      const appointment = await tx.appointment.create({
        data: {
          patientId: patient.id,
          serviceId: service.id,
          durationMin: service.durationMin,
          timezone: parsed.timezone,
          scheduledAt,
          status: "AWAITING_PAYMENT",
        },
      });

      const payment = await tx.payment.create({
        data: {
          patientId: patient.id,
          serviceId: service.id,
          appointmentId: appointment.id,
          amountCents: service.priceCents,
          currency: service.currency,
          receiptUrl,
          receiptMime: req.file!.mimetype,
          status: "PENDING_REVIEW",
        },
      });

      return { patient, intake, appointment, payment };
    });

    // Confirmación al paciente (best-effort; no bloquea la respuesta)
    void sendMail({
      to: parsed.email,
      subject: "Recibimos tu solicitud — NutriVerde",
      template: "intake-confirmation",
      html: confirmationHtml({
        name: parsed.fullName,
        service: service.name,
      }),
    }).catch((err) => console.error("Email a paciente falló:", err));

    // Notificación a la nutricionista
    const adminEmail = await prisma.adminUser.findFirst({
      where: { active: true, role: "NUTRITIONIST" },
      select: { email: true, fullName: true },
    });
    if (adminEmail) {
      void sendMail({
        to: adminEmail.email,
        subject: `Nuevo intake: ${parsed.fullName} — ${service.name}`,
        template: "intake-admin-notify",
        html: adminNotifyHtml({
          patientName: parsed.fullName,
          patientEmail: parsed.email,
          service: service.name,
          goal: parsed.goal || "(sin especificar)",
        }),
      }).catch((err) => console.error("Email admin falló:", err));
    }

    res.status(201).json({
      ok: true,
      intakeId: result.intake.id,
      appointmentId: result.appointment.id,
      message:
        "Recibimos tu solicitud. Te confirmaremos por correo en máximo 24 horas tras verificar tu pago.",
    });
  } catch (err) {
    // Si algo falló después de subir el archivo, limpiamos para no dejar basura
    if (uploadedPath) {
      void fs.unlink(uploadedPath).catch(() => {});
    }
    next(err);
  }
});

function confirmationHtml({ name, service }: { name: string; service: string }): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #059669; font-size: 22px;">¡Hola ${escapeHtml(name)}!</h1>
      <p>Recibimos tu solicitud para <strong>${escapeHtml(service)}</strong>.</p>
      <p>Estamos verificando tu comprobante de pago. En máximo <strong>24 horas</strong> te enviaremos un correo confirmando el pago y un enlace para que elijas el horario de tu consulta.</p>
      <p>Si tienes alguna pregunta urgente, puedes responder este correo.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— NutriVerde</p>
    </div>
  `;
}

function adminNotifyHtml({
  patientName,
  patientEmail,
  service,
  goal,
}: {
  patientName: string;
  patientEmail: string;
  service: string;
  goal: string;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2>Nuevo formulario recibido</h2>
      <ul style="line-height: 1.8;">
        <li><strong>Paciente:</strong> ${escapeHtml(patientName)}</li>
        <li><strong>Correo:</strong> ${escapeHtml(patientEmail)}</li>
        <li><strong>Servicio:</strong> ${escapeHtml(service)}</li>
        <li><strong>Objetivo:</strong> ${escapeHtml(goal)}</li>
      </ul>
      <p>Revisa el comprobante en el panel admin para aprobar o rechazar.</p>
      <p style="color: #6b7280; font-size: 13px;">${env.FRONTEND_ORIGIN}/admin</p>
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
