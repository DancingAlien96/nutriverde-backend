import { Router } from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin, signAdminToken } from "../../middlewares/require-admin.js";

const router = Router();

/**
 * Freno de fuerza bruta sobre el login. Es el único punto de entrada al panel,
 * y detrás de él está el expediente clínico completo.
 *
 * `skipSuccessfulRequests` hace que solo cuenten los intentos fallidos, para
 * no castigar a quien entra bien varias veces desde la misma red.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.",
  },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const admin = await prisma.adminUser.findUnique({ where: { email } });

    // Mensaje genérico para no filtrar si el correo existe o no
    if (!admin || !admin.active) {
      throw new HttpError(401, "Credenciales inválidas.");
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      throw new HttpError(401, "Credenciales inválidas.");
    }

    const token = signAdminToken({
      sub: admin.id,
      email: admin.email,
      role: admin.role,
    });

    res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        fullName: admin.fullName,
        role: admin.role,
        locale: admin.locale,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Renueva la sesion mientras la persona usa el panel: devuelve un token nuevo
 * con el plazo completo (ADMIN_SESSION_IDLE). requireAdmin ya comprobo que el
 * token actual es valido y que la cuenta sigue activa; si no lo usa durante
 * ese plazo, el token vence y tiene que volver a entrar.
 */
router.post("/refresh", requireAdmin, (req, res) => {
  const { sub, email, role } = req.admin!;
  res.json({ token: signAdminToken({ sub, email, role }) });
});

router.get("/me", requireAdmin, async (req, res, next) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.admin!.sub },
      select: { id: true, email: true, fullName: true, role: true, locale: true, active: true },
    });

    if (!admin || !admin.active) {
      throw new HttpError(401, "Cuenta no disponible.");
    }

    res.json({ admin });
  } catch (err) {
    next(err);
  }
});

export default router;
