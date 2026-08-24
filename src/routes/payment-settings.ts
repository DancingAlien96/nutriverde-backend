import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * Datos bancarios para el formulario de agendamiento. Público a propósito:
 * la paciente los necesita antes de subir el comprobante, sin autenticarse.
 * Solo se exponen los campos de depósito, nada de metadatos internos.
 */
router.get("/", async (_req, res, next) => {
  try {
    const s = await prisma.paymentSettings.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default" },
      select: {
        bankName: true,
        accountType: true,
        accountNumber: true,
        accountHolder: true,
        instructions: true,
      },
    });

    // Si aún no se configuran, el frontend muestra un aviso en vez de datos
    // vacíos o de relleno.
    const configured = Boolean(s.bankName && s.accountNumber);
    res.json({ settings: { ...s, configured } });
  } catch (err) {
    next(err);
  }
});

export default router;
