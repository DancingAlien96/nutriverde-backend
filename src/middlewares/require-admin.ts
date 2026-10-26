import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { AdminRole } from "@prisma/client";
import { env } from "../config/env.js";
import { HttpError } from "./error-handler.js";

export interface AdminTokenPayload {
  sub: string; // admin id
  email: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload;
    }
  }
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return next(new HttpError(401, "Falta token de autenticación."));
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AdminTokenPayload;
    req.admin = payload;
    next();
  } catch {
    next(new HttpError(401, "Token inválido o expirado."));
  }
}

/**
 * Roles con acceso completo al panel (pagos, pacientes, expedientes,
 * disponibilidad, servicios). SECRETARY queda fuera a propósito: solo puede
 * agendar citas, ver el calendario y enviar el correo de confirmación.
 */
export const FULL_ACCESS_ROLES: readonly AdminRole[] = ["NUTRITIONIST", "STAFF"];

/**
 * Restringe una ruta a ciertos roles. Debe ir después de requireAdmin (o se
 * encadena internamente si no se corrió antes).
 */
export function requireRole(...roles: readonly AdminRole[]) {
  return function roleGuard(req: Request, res: Response, next: NextFunction): void {
    if (!req.admin) {
      return requireAdmin(req, res, (err?: unknown) => {
        if (err) return next(err);
        roleGuard(req, res, next);
      });
    }
    if (!roles.includes(req.admin.role as AdminRole)) {
      return next(new HttpError(403, "No tienes permiso para esta sección."));
    }
    next();
  };
}

/** Acceso completo: nutricionista y staff. */
export const requireFullAccess = requireRole(...FULL_ACCESS_ROLES);
