import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { prisma } from "./prisma.js";
import { htmlToText } from "./html-to-text.js";

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

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template: string;
}

export async function sendMail(options: SendMailOptions): Promise<void> {
  const log = await prisma.emailLog.create({
    data: {
      to: options.to,
      subject: options.subject,
      template: options.template,
      status: "QUEUED",
    },
  });

  try {
    await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      // Si la plantilla no trae texto propio, lo derivamos del HTML para que
      // el correo salga siempre como multipart/alternative.
      text: options.text ?? htmlToText(options.html),
    });

    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "SENT", sentAt: new Date() },
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
