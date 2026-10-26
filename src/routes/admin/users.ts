import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireRole } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

/**
 * Gestión de usuarios del panel. Solo la nutricionista: es quien decide
 * quién entra y con qué rol (staff, secretaria). Ni el staff ni la
 * secretaria pueden crear cuentas ni tocar las ajenas.
 */
const router = Router();
router.use(requireRole("NUTRITIONIST"));

const ROLES = ["NUTRITIONIST", "STAFF", "SECRETARY"] as const;
const LOCALES = ["EN", "ES"] as const;

const PUBLIC_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  locale: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.adminUser.findMany({
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
      select: PUBLIC_SELECT,
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

const passwordSchema = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres.")
  .max(128);

const createSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Nombre demasiado corto")
    .max(120)
    .refine(isUtf8, utf8Message("El nombre")),
  email: z.string().trim().toLowerCase().email("Correo inválido"),
  password: passwordSchema,
  role: z.enum(ROLES),
  locale: z.enum(LOCALES).default("EN"),
});

router.post("/", async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);

    const exists = await prisma.adminUser.findUnique({ where: { email: input.email } });
    if (exists) throw new HttpError(409, "Ya existe un usuario con ese correo.");

    const user = await prisma.adminUser.create({
      data: {
        fullName: input.fullName,
        email: input.email,
        passwordHash: await bcrypt.hash(input.password, 10),
        role: input.role,
        locale: input.locale,
      },
      select: PUBLIC_SELECT,
    });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Nombre demasiado corto")
      .max(120)
      .refine(isUtf8, utf8Message("El nombre"))
      .optional(),
    role: z.enum(ROLES).optional(),
    locale: z.enum(LOCALES).optional(),
    active: z.boolean().optional(),
    password: passwordSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Nada que actualizar." });

/**
 * Edita nombre, rol, estado o contraseña. Dos candados para no dejar el
 * panel sin dueña: nadie puede desactivarse ni quitarse el rol a sí misma,
 * y siempre debe quedar al menos una nutricionista activa.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    const me = req.admin!.sub;

    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!target) throw new HttpError(404, "Usuario no encontrado.");

    const demoting = patch.role !== undefined && patch.role !== "NUTRITIONIST";
    const deactivating = patch.active === false;

    if (target.id === me && (demoting || deactivating)) {
      throw new HttpError(409, "No puedes desactivar ni cambiar el rol de tu propia cuenta.");
    }

    if (target.role === "NUTRITIONIST" && target.active && (demoting || deactivating)) {
      const others = await prisma.adminUser.count({
        where: { role: "NUTRITIONIST", active: true, id: { not: target.id } },
      });
      if (others === 0) {
        throw new HttpError(409, "Debe quedar al menos una nutricionista activa.");
      }
    }

    const user = await prisma.adminUser.update({
      where: { id: target.id },
      data: {
        ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.password !== undefined
          ? { passwordHash: await bcrypt.hash(patch.password, 10) }
          : {}),
      },
      select: PUBLIC_SELECT,
    });

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
