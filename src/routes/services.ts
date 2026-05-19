import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const services = await prisma.service.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        priceCents: true,
        currency: true,
        durationMin: true,
        billingType: true,
      },
    });

    res.json({
      services: services.map((s) => ({
        ...s,
        priceFormatted: formatPrice(s.priceCents, s.currency),
      })),
    });
  } catch (err) {
    next(err);
  }
});

function formatPrice(cents: number, currency: string): string {
  const amount = cents / 100;
  if (currency === "GTQ") {
    return `Q${amount.toFixed(0)}`;
  }
  return `${currency} ${amount.toFixed(2)}`;
}

export default router;
