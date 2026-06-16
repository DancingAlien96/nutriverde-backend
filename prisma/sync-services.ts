import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// Sincroniza los servicios de producción con el estado de desarrollo.
// Generado automáticamente — idempotente (upsert por slug).
const prisma = new PrismaClient();

const SERVICES = [
  {
    "slug": "consulta-inicial",
    "name": "Initial Consultation",
    "description": "A comprehensive assessment of your health, habits, lifestyle, and goals. We'll review your medical history, current diet, routine, and specific needs to build a personalized, sustainable nutrition strategy.",
    "nameEn": "Initial Consultation",
    "nameEs": "Consulta inicial",
    "descriptionEn": "A comprehensive assessment of your health, habits, lifestyle, and goals. We'll review your medical history, current diet, routine, and specific needs to build a personalized, sustainable nutrition strategy.",
    "descriptionEs": "Una evaluación exhaustiva de su salud, hábitos, estilo de vida y objetivos. Revisaremos su historial médico, dieta actual, rutina y necesidades específicas para construir una estrategia de nutrición personalizada y sostenible.",
    "priceCents": 40000,
    "priceUsdCents": 6900,
    "currency": "GTQ",
    "durationMin": 60,
    "billingType": "ONE_TIME",
    "sortOrder": 1,
    "active": true
  },
  {
    "slug": "consulta-seguimiento",
    "name": "Follow-up Consultation",
    "description": "Designed to assess your progress, work through challenges, and make the adjustments needed to keep moving toward your goals in a realistic, sustainable way.",
    "nameEn": "Follow-up Consultation",
    "nameEs": "consulta de seguimiento",
    "descriptionEn": "Designed to assess your progress, work through challenges, and make the adjustments needed to keep moving toward your goals in a realistic, sustainable way.",
    "descriptionEs": "Diseñado para evaluar tu progreso, superar los desafíos y hacer los ajustes necesarios para seguir avanzando hacia tus objetivos de una manera realista y sostenible.",
    "priceCents": 35000,
    "priceUsdCents": 5500,
    "currency": "GTQ",
    "durationMin": 45,
    "billingType": "ONE_TIME",
    "sortOrder": 2,
    "active": true
  },
  {
    "slug": "coaching-nutricional",
    "name": "Nutrition Coaching",
    "description": "A space focused on helping you make lasting changes to your eating and lifestyle. Ideal for improving your relationship with food, building healthy habits, and maintaining results long term.",
    "nameEn": "Nutrition Coaching",
    "nameEs": "Asesoramiento nutricional",
    "descriptionEn": "A space focused on helping you make lasting changes to your eating and lifestyle. Ideal for improving your relationship with food, building healthy habits, and maintaining results long term.",
    "descriptionEs": "Un espacio centrado en ayudarte a realizar cambios duraderos en tu alimentación y estilo de vida. Ideal para mejorar tu relación con la comida, desarrollar hábitos saludables y mantener los resultados a largo plazo.",
    "priceCents": 45000,
    "priceUsdCents": 7500,
    "currency": "GTQ",
    "durationMin": 60,
    "billingType": "ONE_TIME",
    "sortOrder": 3,
    "active": true
  },
  {
    "slug": "nutricion-deportiva",
    "name": "Sports Nutrition",
    "description": "For runners, athletes, and anyone preparing for competitions or endurance events. Evidence-based fueling, hydration, and supplementation strategies to optimize performance and recovery.",
    "nameEn": "Sports Nutrition",
    "nameEs": "Nutrición Deportiva",
    "descriptionEn": "For runners, athletes, and anyone preparing for competitions or endurance events. Evidence-based fueling, hydration, and supplementation strategies to optimize performance and recovery.",
    "descriptionEs": "Para corredores, atletas y cualquier persona que se prepare para competiciones o eventos de resistencia. Estrategias de alimentación, hidratación y suplementación basadas en la evidencia para optimizar el rendimiento y la recuperación.",
    "priceCents": 45000,
    "priceUsdCents": 7500,
    "currency": "GTQ",
    "durationMin": 60,
    "billingType": "ONE_TIME",
    "sortOrder": 4,
    "active": true
  }
];

async function main() {
  for (const s of SERVICES) {
    await prisma.service.upsert({ where: { slug: s.slug }, update: s, create: s });
  }
  // El Plan Premium queda inactivo (no se ofrece).
  await prisma.service.updateMany({ where: { slug: "plan-premium" }, data: { active: false } });

  const all = await prisma.service.findMany({ orderBy: { sortOrder: "asc" } });
  for (const x of all) {
    const usd = x.priceUsdCents != null ? "US$" + (x.priceUsdCents / 100).toFixed(0) : "-";
    console.log((x.active ? "OK " : "off") + " " + x.slug + " | " + x.name + " | Q" + (x.priceCents / 100).toFixed(0) + " / " + usd);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
