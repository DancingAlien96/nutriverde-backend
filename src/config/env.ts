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

  // JWT para sesiones admin
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Uploads
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),

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

export const env = parsed.data;
export type Env = typeof env;
