import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";

const router = Router();
router.use(requireAdmin);

/** Devuelve la fila singleton, creándola vacía la primera vez. */
async function getOrCreate() {
  return prisma.paymentSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}

router.get("/", async (_req, res, next) => {
  try {
    res.json({ settings: await getOrCreate() });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  bankName: z.string().trim().max(120).refine(isUtf8, utf8Message("El banco")),
  accountType: z
    .string()
    .trim()
    .max(60)
    .refine(isUtf8, utf8Message("El tipo de cuenta")),
  accountNumber: z
    .string()
    .trim()
    .max(60)
    .refine(isUtf8, utf8Message("El número de cuenta")),
  accountHolder: z
    .string()
    .trim()
    .max(150)
    .refine(isUtf8, utf8Message("El titular")),
  instructions: z
    .string()
    .trim()
    .max(1000)
    .refine(isUtf8, utf8Message("Las instrucciones"))
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
});

router.put("/", async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    await getOrCreate();
    const settings = await prisma.paymentSettings.update({
      where: { id: "default" },
      data,
    });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

export default router;
