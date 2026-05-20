import { Router } from "express";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import type { PaymentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { sendMail } from "../../lib/mailer.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";

const router = Router();
router.use(requireAdmin);

const VALID_STATUSES = new Set<PaymentStatus>([
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
]);

router.get("/", async (req, res, next) => {
  try {
    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam && VALID_STATUSES.has(statusParam as PaymentStatus)
        ? (statusParam as PaymentStatus)
        : undefined;

    const payments = await prisma.payment.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        patient: {
          select: { id: true, fullName: true, email: true, phone: true },
        },
        service: {
          select: { id: true, name: true, slug: true, durationMin: true },
        },
        appointment: {
          select: { id: true, status: true, scheduledAt: true },
        },
      },
    });

    res.json({ payments });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: {
        patient: true,
        service: true,
        appointment: true,
        approvedBy: {
          select: { id: true, email: true, fullName: true },
        },
      },
    });

    if (!payment) throw new HttpError(404, "Pago no encontrado.");

    // También adjuntamos el último intake del paciente (datos del form)
    const intake = await prisma.intakeForm.findFirst({
      where: { patientId: payment.patientId },
      orderBy: { submittedAt: "desc" },
    });

    res.json({ payment, intake });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true, appointment: true },
    });

    if (!payment) throw new HttpError(404, "Pago no encontrado.");
    if (payment.status === "APPROVED") {
      throw new HttpError(409, "Este pago ya fue aprobado.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "APPROVED",
          approvedById: req.admin!.sub,
          approvedAt: new Date(),
          rejectedReason: null,
        },
      });

      if (payment.appointmentId) {
        await tx.appointment.update({
          where: { id: payment.appointmentId },
          data: { status: "PAYMENT_APPROVED" },
        });
      }

      return p;
    });

    void sendMail({
      to: payment.patient.email,
      subject: "Tu pago fue confirmado — NutriVerde",
      template: "payment-approved",
      html: paymentApprovedHtml({
        name: payment.patient.fullName,
        service: payment.service.name,
      }),
    }).catch((err) => console.error("Email approval falló:", err));

    res.json({ ok: true, payment: updated });
  } catch (err) {
    next(err);
  }
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, "Indica una razón").max(500),
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    const { reason } = rejectSchema.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true },
    });

    if (!payment) throw new HttpError(404, "Pago no encontrado.");
    if (payment.status === "REJECTED") {
      throw new HttpError(409, "Este pago ya fue rechazado.");
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "REJECTED",
        rejectedReason: reason,
        approvedAt: null,
        approvedById: null,
      },
    });

    void sendMail({
      to: payment.patient.email,
      subject: "Acerca de tu solicitud — NutriVerde",
      template: "payment-rejected",
      html: paymentRejectedHtml({
        name: payment.patient.fullName,
        service: payment.service.name,
        reason,
      }),
    }).catch((err) => console.error("Email rejection falló:", err));

    res.json({ ok: true, payment: updated });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/receipt", async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { receiptUrl: true, receiptMime: true },
    });

    if (!payment) throw new HttpError(404, "Pago no encontrado.");

    // receiptUrl es algo como "/uploads/receipts/xxx.png"
    const safeRel = payment.receiptUrl.replace(/^\/?uploads\//, "");
    const absUploadDir = path.resolve(env.UPLOAD_DIR);
    const absFile = path.resolve(absUploadDir, safeRel);

    // Asegurar que no se escape del directorio (path traversal)
    if (!absFile.startsWith(absUploadDir + path.sep) && absFile !== absUploadDir) {
      throw new HttpError(400, "Ruta de archivo inválida.");
    }

    if (!fs.existsSync(absFile)) {
      throw new HttpError(404, "Comprobante no encontrado en disco.");
    }

    if (payment.receiptMime) {
      res.type(payment.receiptMime);
    }
    res.sendFile(absFile);
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

function paymentApprovedHtml({ name, service }: { name: string; service: string }): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #059669; font-size: 22px;">¡Tu pago fue confirmado, ${escapeHtml(name)}!</h1>
      <p>Verificamos tu comprobante por <strong>${escapeHtml(service)}</strong> y todo está en orden.</p>
      <p>En breve te enviaremos un correo con el enlace para que elijas el horario de tu consulta.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— NutriVerde</p>
    </div>
  `;
}

function paymentRejectedHtml({
  name,
  service,
  reason,
}: {
  name: string;
  service: string;
  reason: string;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #b91c1c; font-size: 22px;">Hola ${escapeHtml(name)},</h1>
      <p>No pudimos validar tu comprobante para <strong>${escapeHtml(service)}</strong>.</p>
      <p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>
      <p>Si crees que es un error o quieres reenviar el comprobante, responde a este correo y lo revisamos.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— NutriVerde</p>
    </div>
  `;
}

export default router;
