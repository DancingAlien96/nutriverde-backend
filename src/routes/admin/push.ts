import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { pushEnabled, pushToAdmin } from "../../lib/push.js";

/**
 * Suscripciones push de la usuaria del panel (cualquier rol). El navegador
 * crea la suscripción con la llave pública VAPID y aquí se guarda ligada a
 * la cuenta; un mismo dispositivo puede cambiar de dueña (se reasigna).
 */
const router = Router();
router.use(requireAdmin);

router.get("/public-key", (_req, res) => {
  res.json({ publicKey: pushEnabled() ? env.VAPID_PUBLIC_KEY : null });
});

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(500),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
  userAgent: z.string().max(255).optional(),
});

router.post("/subscribe", async (req, res, next) => {
  try {
    if (!pushEnabled()) {
      throw new HttpError(503, "Las notificaciones push no están configuradas en el servidor.");
    }
    const input = subscriptionSchema.parse(req.body);
    await prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        adminUserId: req.admin!.sub,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? req.get("user-agent")?.slice(0, 255) ?? null,
      },
      update: {
        adminUserId: req.admin!.sub,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? req.get("user-agent")?.slice(0, 255) ?? null,
      },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const endpointSchema = z.object({ endpoint: z.string().url().max(500) });

/** ¿Esta suscripción del navegador está registrada para la usuaria actual? */
router.get("/subscribe", async (req, res, next) => {
  try {
    const { endpoint } = endpointSchema.parse({ endpoint: req.query.endpoint });
    const row = await prisma.pushSubscription.findUnique({
      where: { endpoint },
      select: { adminUserId: true },
    });
    res.json({ subscribed: !!row && row.adminUserId === req.admin!.sub });
  } catch (err) {
    next(err);
  }
});

router.delete("/subscribe", async (req, res, next) => {
  try {
    const { endpoint } = endpointSchema.parse(req.body);
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, adminUserId: req.admin!.sub },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Notificación de prueba a los dispositivos de quien la pide. */
router.post("/test", async (req, res, next) => {
  try {
    if (!pushEnabled()) {
      throw new HttpError(503, "Las notificaciones push no están configuradas en el servidor.");
    }
    const result = await pushToAdmin(req.admin!.sub, {
      title: "Notificaciones activas",
      body: "Así se verán los avisos del panel de Plenha Nutrition.",
      url: "/admin/citas",
      tag: "push-test",
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
