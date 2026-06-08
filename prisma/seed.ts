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
        "Una evaluación integral de tu salud, hábitos, estilo de vida y objetivos. Revisaremos tu historial médico, alimentación actual, rutina y necesidades específicas para desarrollar una estrategia nutricional personalizada y sostenible.",
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
        "Diseñadas para evaluar avances, resolver dificultades y realizar los ajustes necesarios para continuar progresando hacia tus objetivos de manera realista y sostenible.",
      priceCents: 25000, // Q250.00
      currency: "GTQ",
      durationMin: 45,
      billingType: "ONE_TIME" as const,
      sortOrder: 2,
    },
    {
      slug: "coaching-nutricional",
      name: "Coaching Nutricional y Cambio de Hábitos",
      description:
        "Un espacio enfocado en ayudarte a implementar cambios duraderos en tu alimentación y estilo de vida. Ideal para mejorar tu relación con la comida, fortalecer hábitos saludables y desarrollar estrategias prácticas para mantener resultados a largo plazo.",
      priceCents: 0, // pendiente de definir por la nutricionista
      currency: "GTQ",
      durationMin: 60,
      billingType: "ONE_TIME" as const,
      sortOrder: 3,
    },
    {
      slug: "nutricion-deportiva",
      name: "Nutrición Deportiva",
      description:
        "Diseñada para corredores, atletas y personas que se preparan para competencias o eventos de resistencia. Estrategias de alimentación, hidratación y suplementación basadas en evidencia para optimizar el rendimiento, favorecer la recuperación y apoyar tus objetivos deportivos.",
      priceCents: 0, // pendiente de definir por la nutricionista
      currency: "GTQ",
      durationMin: 60,
      billingType: "ONE_TIME" as const,
      sortOrder: 4,
    },
  ];

  for (const s of services) {
    await prisma.service.upsert({
      where: { slug: s.slug },
      update: s,
      create: s,
    });
  }

  // Desactivar el servicio "Plan Premium" anterior si existe (ya no se ofrece).
  await prisma.service.updateMany({
    where: { slug: "plan-premium" },
    data: { active: false },
  });

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
