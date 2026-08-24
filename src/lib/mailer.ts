import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";
import { env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { htmlToText } from "./html-to-text.js";

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template: string;
}

/** Lo que devuelve un proveedor tras aceptar el mensaje. */
interface DeliveryResult {
  /** Id del proveedor, si lo da. Sirve para rastrear el envío después. */
  messageId: string | null;
}

// ── SMTP (nodemailer) ──────────────────────────────────────────────
let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  if (!env.SMTP_USER || !env.SMTP_PASS) {
    // En desarrollo sin credenciales: stream a consola
    cachedTransporter = nodemailer.createTransport({ jsonTransport: true });
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return cachedTransporter;
}

async function sendViaSmtp(
  o: SendMailOptions,
  text: string,
): Promise<DeliveryResult> {
  const info = await getTransporter().sendMail({
    from: env.MAIL_FROM,
    to: o.to,
    subject: o.subject,
    html: o.html,
    text,
  });
  return { messageId: info.messageId ?? null };
}

// ── Resend (API HTTPS) ─────────────────────────────────────────────
let cachedResend: Resend | null = null;

function getResend(): Resend {
  // env.ts ya garantiza que la key existe cuando MAIL_PROVIDER=resend.
  cachedResend ??= new Resend(env.RESEND_API_KEY);
  return cachedResend;
}

async function sendViaResend(
  o: SendMailOptions,
  text: string,
): Promise<DeliveryResult> {
  const { data, error } = await getResend().emails.send({
    from: env.MAIL_FROM,
    to: o.to,
    subject: o.subject,
    html: o.html,
    text,
  });

  // El SDK NO lanza excepción ante un error de la API: lo devuelve. Sin este
  // chequeo un rechazo (dominio sin verificar, cuota agotada) se registraría
  // como enviado.
  if (error) {
    throw new Error(`Resend: ${error.name} — ${error.message}`);
  }

  return { messageId: data?.id ?? null };
}

// ── API pública ────────────────────────────────────────────────────
export async function sendMail(options: SendMailOptions): Promise<void> {
  const log = await prisma.emailLog.create({
    data: {
      to: options.to,
      subject: options.subject,
      template: options.template,
      status: "QUEUED",
    },
  });

  // Si la plantilla no trae texto propio, lo derivamos del HTML para que el
  // correo salga siempre como multipart/alternative.
  const text = options.text ?? htmlToText(options.html);

  try {
    const result =
      env.MAIL_PROVIDER === "resend"
        ? await sendViaResend(options, text)
        : await sendViaSmtp(options, text);

    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: result.messageId,
      },
    });
  } catch (err) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}
