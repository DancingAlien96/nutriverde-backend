import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

const router = Router();
router.use(requireAdmin);

/** Id del admin autenticado (lo coloca requireAdmin en req.admin.sub). */
function adminId(req: { admin?: { sub: string } }): string {
  const id = req.admin?.sub;
  if (!id) throw new HttpError(401, "Sesión inválida.");
  return id;
}

// Lista los recordatorios del admin (pendientes primero, luego por fecha).
router.get("/", async (req, res, next) => {
  try {
    const reminders = await prisma.reminder.findMany({
      where: { adminId: adminId(req) },
      orderBy: [{ done: "asc" }, { createdAt: "desc" }],
    });
    res.json({ reminders });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Escribe el texto de la tarea.")
    .max(500)
    .refine(isUtf8, utf8Message("La tarea")),
  dueAt: z.string().datetime().optional().nullable(),
});

router.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const reminder = await prisma.reminder.create({
      data: {
        adminId: adminId(req),
        text: data.text,
        dueAt: data.dueAt ? new Date(data.dueAt) : null,
      },
    });
    res.status(201).json({ reminder });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(isUtf8, utf8Message("La tarea"))
    .optional(),
  done: z.boolean().optional(),
  dueAt: z.string().datetime().optional().nullable(),
});

router.put("/:id", async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    // Solo puede tocar sus propios recordatorios.
    const existing = await prisma.reminder.findFirst({
      where: { id: req.params.id, adminId: adminId(req) },
    });
    if (!existing) throw new HttpError(404, "Recordatorio no encontrado.");

    const reminder = await prisma.reminder.update({
      where: { id: existing.id },
      data: {
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.done !== undefined ? { done: patch.done } : {}),
        ...(patch.dueAt !== undefined
          ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null }
          : {}),
      },
    });
    res.json({ reminder });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.reminder.findFirst({
      where: { id: req.params.id, adminId: adminId(req) },
    });
    if (!existing) throw new HttpError(404, "Recordatorio no encontrado.");
    await prisma.reminder.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
