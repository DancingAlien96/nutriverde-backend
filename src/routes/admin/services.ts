import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";
import { toBilingual } from "../../lib/translate.js";
import {
  serviceImageUpload,
  servicesImageDir,
  toPublicUrl,
} from "../../lib/upload.js";
import path from "node:path";
import fs from "node:fs";

const router = Router();
router.use(requireAdmin);

router.get("/", async (_req, res, next) => {
  try {
    const services = await prisma.service.findMany({
      orderBy: { sortOrder: "asc" },
    });
    res.json({ services });
  } catch (err) {
    next(err);
  }
});

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Solo minúsculas, números y guiones (ej. consulta-extendida)",
  );

const createSchema = z.object({
  slug: slugSchema,
  name: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .refine(isUtf8, utf8Message("El nombre")),
  description: z
    .string()
    .trim()
    .max(2000)
    .refine(isUtf8, utf8Message("La descripción")),
  priceCents: z.number().int().min(0),
  currency: z.string().trim().length(3).default("GTQ"),
  durationMin: z.number().int().min(0).max(8 * 60),
  billingType: z.enum(["ONE_TIME", "MONTHLY"]).default("ONE_TIME"),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);

    const existing = await prisma.service.findUnique({
      where: { slug: data.slug },
    });
    if (existing) {
      throw new HttpError(409, `Ya existe un servicio con slug "${data.slug}".`);
    }

    // Si no se pasa sortOrder, lo poemos al final
    let sortOrder = data.sortOrder;
    if (sortOrder === undefined) {
      const last = await prisma.service.findFirst({
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? 0) + 1;
    }

    // Auto-traducción overlay EN/ES (no bloquea si falla).
    const [nameTr, descTr] = await Promise.all([
      toBilingual(data.name),
      toBilingual(data.description),
    ]);

    const service = await prisma.service.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description,
        nameEn: nameTr.en,
        nameEs: nameTr.es,
        descriptionEn: descTr.en,
        descriptionEs: descTr.es,
        priceCents: data.priceCents,
        currency: data.currency,
        durationMin: data.durationMin,
        billingType: data.billingType,
        active: data.active ?? true,
        sortOrder,
      },
    });
    res.status(201).json({ service });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .refine(isUtf8, utf8Message("El nombre"))
    .optional(),
  description: z
    .string()
    .trim()
    .max(2000)
    .refine(isUtf8, utf8Message("La descripción"))
    .optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
  durationMin: z.number().int().min(0).max(8 * 60).optional(),
  billingType: z.enum(["ONE_TIME", "MONTHLY"]).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

router.put("/:id", async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    const existing = await prisma.service.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw new HttpError(404, "Servicio no encontrado.");

    // Si cambió el nombre o la descripción, regeneramos las traducciones.
    const translations: {
      nameEn?: string;
      nameEs?: string;
      descriptionEn?: string;
      descriptionEs?: string;
    } = {};
    if (patch.name !== undefined) {
      const tr = await toBilingual(patch.name);
      translations.nameEn = tr.en;
      translations.nameEs = tr.es;
    }
    if (patch.description !== undefined) {
      const tr = await toBilingual(patch.description);
      translations.descriptionEn = tr.en;
      translations.descriptionEs = tr.es;
    }

    const service = await prisma.service.update({
      where: { id: req.params.id },
      data: { ...patch, ...translations },
    });
    res.json({ service });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.service.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { appointments: true, payments: true } },
      },
    });
    if (!existing) throw new HttpError(404, "Servicio no encontrado.");

    if (existing._count.appointments > 0 || existing._count.payments > 0) {
      throw new HttpError(
        409,
        "Este servicio tiene citas o pagos asociados. Para ocultarlo, marca 'Inactivo' en lugar de eliminarlo.",
      );
    }

    await prisma.service.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Sube/reemplaza la imagen pública de un servicio (campo "image").
router.post(
  "/:id/image",
  serviceImageUpload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, "No image file was uploaded.");

      const existing = await prisma.service.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        // Limpia el archivo recién subido si el servicio no existe.
        fs.unlink(req.file.path, () => {});
        throw new HttpError(404, "Servicio no encontrado.");
      }

      const imageUrl = toPublicUrl(req.file.path);
      const service = await prisma.service.update({
        where: { id: req.params.id },
        data: { imageUrl },
      });

      // Borra la imagen anterior (si era una subida nuestra y cambió).
      if (
        existing.imageUrl &&
        existing.imageUrl !== imageUrl &&
        existing.imageUrl.startsWith("/uploads/services/")
      ) {
        const oldName = path.basename(existing.imageUrl);
        fs.unlink(path.join(servicesImageDir, oldName), () => {});
      }

      res.json({ service });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
