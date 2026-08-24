import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Orígenes permitidos para CORS. Acepta:
  // - URL única: "https://nutriverde.com"
  // - Lista separada por comas: "https://a.com,https://b.com"
  // - Wildcard de subdominio: "https://*.vercel.app"
  // - "*" para permitir cualquier origen (no recomendado con credentials).
  FRONTEND_ORIGIN: z
    .string()
    .min(1)
    .default("http://localhost:3000")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),

  // URL canónica del sitio. A diferencia de FRONTEND_ORIGIN (que es una lista
  // de orígenes permitidos para CORS y admite comodines), esta es UNA sola URL
  // concreta y se usa para construir los enlaces que se envían por correo.
  // Si se omite, se toma el primer origen de FRONTEND_ORIGIN.
  PUBLIC_BASE_URL: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v)),

  // JWT para sesiones admin
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Uploads
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),

  // Proveedor de correo. "resend" usa su API HTTPS (recomendado en prod:
  // no depende del puerto 25/587 y permite autenticar el dominio propio).
  // "smtp" mantiene el envío por nodemailer.
  MAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),

  // SMTP (Gmail) — string vacía equivale a "no configurado"
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z
    .union([z.string().email(), z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  SMTP_PASS: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  MAIL_FROM: z.string().default("Plenha Nutrition <no-reply@plenhanutrition.com>"),

  // Meta del negocio
  BUSINESS_TIMEZONE: z.string().default("America/Guatemala"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Los enlaces por correo necesitan una URL concreta: interpolar el array de
// FRONTEND_ORIGIN produciría "https://a.com,https://b.com/agendar-cita/...".
// Con MAIL_PROVIDER=resend la API key es obligatoria: sin ella el envío
// fallaría en tiempo de ejecución, cuando ya hay una paciente esperando el
// correo. Mejor no arrancar.
if (parsed.data.MAIL_PROVIDER === "resend" && !parsed.data.RESEND_API_KEY) {
  console.error(
    "Invalid environment variables: MAIL_PROVIDER=resend requiere RESEND_API_KEY.",
  );
  process.exit(1);
}

const publicBaseUrl = (
  parsed.data.PUBLIC_BASE_URL ?? parsed.data.FRONTEND_ORIGIN[0]
).replace(/\/+$/, "");

if (publicBaseUrl.includes("*")) {
  console.error(
    "Invalid environment variables: PUBLIC_BASE_URL no puede contener comodines. " +
      "Declárala con la URL canónica del sitio, p. ej. https://plenhanutrition.com",
  );
  process.exit(1);
}

export const env = { ...parsed.data, PUBLIC_BASE_URL: publicBaseUrl };
export type Env = typeof env;
