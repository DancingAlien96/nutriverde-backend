import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: corsOriginCheck,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Los uploads (comprobantes, planes PDF) NO se sirven públicamente.
  // Se acceden vía endpoints autenticados: /api/admin/payments/:id/receipt etc.
  // EXCEPCIÓN: las imágenes de servicios SÍ son públicas (se muestran en la
  // landing). Solo exponemos esa subcarpeta, no toda la carpeta de uploads.
  app.use(
    "/uploads/services",
    express.static(path.join(env.UPLOAD_DIR, "services"), {
      maxAge: "7d",
      fallthrough: false,
      setHeaders: (res) => {
        // Permite que el frontend (otro origen) incruste la imagen.
        // helmet pone CORP: same-origin por defecto, que la bloquearía.
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    }),
  );

  app.use("/api", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Valida si el origen está permitido. Soporta:
 * - Match exacto (case-insensitive)
 * - Wildcard "*" (cualquier origen — desactiva la protección)
 * - Wildcard de subdominio: "https://*.vercel.app" matchea
 *   "https://foo.vercel.app", "https://foo-bar.vercel.app", etc.
 */
function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // Requests sin Origin (curl, server-to-server) se permiten.
  if (!origin) return callback(null, true);

  const allowed = env.FRONTEND_ORIGIN;
  const ok = allowed.some((pattern) => matchOrigin(pattern, origin));

  if (ok) return callback(null, true);
  callback(new Error(`Origin ${origin} no permitido por CORS`));
}

function matchOrigin(pattern: string, origin: string): boolean {
  if (pattern === "*") return true;
  if (pattern.toLowerCase() === origin.toLowerCase()) return true;

  // Wildcard solo en el host (no en el path ni protocolo).
  if (pattern.includes("*")) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const re = new RegExp(`^${escaped}$`, "i");
    return re.test(origin);
  }
  return false;
}
