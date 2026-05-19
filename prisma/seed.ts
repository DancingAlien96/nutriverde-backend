import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@nutriverde.local";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "Nutricionista";

async function seedServices() {
  const services = [
    {
      slug: "consulta-inicial",
      name: "Consulta Inicial",
      description:
        "Evaluación completa de tu estado nutricional, hábitos alimentarios, objetivos y plan de alimentación personalizado para comenzar tu transformación.",
      priceCents: 35000, // Q350.00
      currency: "GTQ",
      durationMin: 60,
      billingType: "ONE_TIME" as const,
      sortOrder: 1,
    },
    {
      slug: "consulta-seguimiento",
      name: "Consulta de Seguimiento",
      description:
        "Revisamos tus avances, ajustamos el plan según tus resultados y resolvemos dudas para mantener tu progreso.",
      priceCents: 25000, // Q250.00
      currency: "GTQ",
      durationMin: 45,
      billingType: "ONE_TIME" as const,
      sortOrder: 2,
    },
    {
      slug: "plan-premium",
      name: "Plan Nutricional Premium",
      description:
        "Acompañamiento mensual con plan completo, ajustes ilimitados y soporte continuo por WhatsApp.",
      priceCents: 55000, // Q550.00
      currency: "GTQ",
      durationMin: 60,
      billingType: "MONTHLY" as const,
      sortOrder: 3,
    },
  ];

  for (const s of services) {
    await prisma.service.upsert({
      where: { slug: s.slug },
      update: s,
      create: s,
    });
  }
  console.log(`✓ Upserted ${services.length} services`);
}

async function seedAdmin() {
  const existing = await prisma.adminUser.findUnique({
    where: { email: SEED_ADMIN_EMAIL },
  });

  if (existing) {
    console.log(`✓ Admin user already exists: ${SEED_ADMIN_EMAIL}`);
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 10);

  await prisma.adminUser.create({
    data: {
      email: SEED_ADMIN_EMAIL,
      passwordHash,
      fullName: SEED_ADMIN_NAME,
      role: "NUTRITIONIST",
    },
  });

  console.log(`✓ Created admin user: ${SEED_ADMIN_EMAIL}`);
  if (SEED_ADMIN_PASSWORD === "ChangeMe123!") {
    console.warn(
      "⚠  Default admin password in use (ChangeMe123!). Change it via SEED_ADMIN_PASSWORD in .env",
    );
  }
}

async function seedAvailability() {
  // Solo se semilla la primera vez (si no hay slots configurados)
  const count = await prisma.availabilitySlot.count();
  if (count > 0) {
    console.log(`✓ Availability slots already configured (${count})`);
    return;
  }

  // Lunes a viernes, 8:00 a 17:00 (configurable después desde admin panel)
  const slots = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startMinute: 8 * 60,
    endMinute: 17 * 60,
    active: true,
  }));

  await prisma.availabilitySlot.createMany({ data: slots });
  console.log(`✓ Created ${slots.length} default availability slots (Mon–Fri 8:00–17:00)`);
}

async function main() {
  console.log("Seeding database…");
  await seedServices();
  await seedAdmin();
  await seedAvailability();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
