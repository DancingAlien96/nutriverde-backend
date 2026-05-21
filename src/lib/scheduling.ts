import { prisma } from "./prisma.js";

// Guatemala usa UTC-6 todo el año (sin DST). Si el negocio se mueve a una zona
// con DST, reemplazar esta constante con un helper basado en Intl/luxon/date-fns-tz.
const BUSINESS_OFFSET_MIN = 6 * 60;

// Slots se ofrecen cada 30 min — los servicios pueden ser de 45/60 min y aun
// así empezar a la media hora.
const SLOT_INCREMENT_MIN = 30;

/** Lee configuración de scheduling (singleton), creando defaults si no existe. */
async function getSettings(): Promise<{
  allowSameDayBooking: boolean;
  minLeadMinutes: number;
}> {
  const s = await prisma.schedulingSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
    select: { allowSameDayBooking: true, minLeadMinutes: true },
  });
  return s;
}

/** ¿Una fecha es "hoy" en hora Guatemala? */
function isSameBusinessDay(d: Date): boolean {
  const local = new Date(d.getTime() - BUSINESS_OFFSET_MIN * 60_000);
  const now = new Date(Date.now() - BUSINESS_OFFSET_MIN * 60_000);
  return (
    local.getUTCFullYear() === now.getUTCFullYear() &&
    local.getUTCMonth() === now.getUTCMonth() &&
    local.getUTCDate() === now.getUTCDate()
  );
}

/** Convierte una fecha YYYY-MM-DD (interpretada en hora de Guatemala) a su rango UTC. */
export function businessDateToUtcRange(dateStr: string): {
  start: Date;
  end: Date;
  dayOfWeek: number;
} {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`Fecha inválida: ${dateStr}`);
  }
  // 00:00 GT = 06:00 UTC (UTC-6)
  const start = new Date(Date.UTC(y, m - 1, d, BUSINESS_OFFSET_MIN / 60, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  // start.getUTCDay() en este instante corresponde al día de la semana en GT
  return { start, end, dayOfWeek: start.getUTCDay() };
}

/** Convierte un Date a "hora local" en minutos desde medianoche, en BUSINESS_TIMEZONE. */
export function utcToBusinessMinuteOfDay(d: Date): number {
  const localMs = d.getTime() - BUSINESS_OFFSET_MIN * 60_000;
  const local = new Date(localMs);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

export interface SlotOptions {
  date: string; // YYYY-MM-DD en hora GT
  durationMin: number;
  excludeAppointmentId?: string;
}

export async function getAvailableSlots(opts: SlotOptions): Promise<Date[]> {
  const { date, durationMin, excludeAppointmentId } = opts;
  const { start: dayStart, end: dayEnd, dayOfWeek } = businessDateToUtcRange(date);

  const [windows, blocks, taken, settings] = await Promise.all([
    prisma.availabilitySlot.findMany({
      where: { dayOfWeek, active: true },
      orderBy: { startMinute: "asc" },
    }),
    prisma.availabilityBlock.findMany({
      where: {
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
    }),
    prisma.appointment.findMany({
      where: {
        scheduledAt: { gte: dayStart, lt: dayEnd },
        status: { in: ["SCHEDULED", "COMPLETED"] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { scheduledAt: true, durationMin: true },
    }),
    getSettings(),
  ]);

  if (windows.length === 0) return [];

  // Si está prohibido reservar mismo día y la fecha es hoy → no hay slots
  if (!settings.allowSameDayBooking && isSameBusinessDay(dayStart)) {
    return [];
  }

  const minStart = new Date(Date.now() + settings.minLeadMinutes * 60_000);

  const slots: Date[] = [];

  for (const w of windows) {
    let m = w.startMinute;
    while (m + durationMin <= w.endMinute) {
      const slotStart = new Date(dayStart.getTime() + m * 60_000);
      const slotEnd = new Date(slotStart.getTime() + durationMin * 60_000);

      const passesLeadTime = slotStart >= minStart;
      const notBlocked = !blocks.some(
        (b) => b.startsAt < slotEnd && b.endsAt > slotStart,
      );
      const notTaken = !taken.some((a) => {
        if (!a.scheduledAt) return false;
        const aEnd = new Date(a.scheduledAt.getTime() + a.durationMin * 60_000);
        return a.scheduledAt < slotEnd && aEnd > slotStart;
      });

      if (passesLeadTime && notBlocked && notTaken) {
        slots.push(slotStart);
      }

      m += SLOT_INCREMENT_MIN;
    }
  }

  return slots;
}

/** Lista los próximos N días que tienen al menos una availability window configurada. */
export async function getCandidateDates(daysAhead: number): Promise<string[]> {
  const windows = await prisma.availabilitySlot.findMany({
    where: { active: true },
    select: { dayOfWeek: true },
  });
  const activeDays = new Set(windows.map((w) => w.dayOfWeek));

  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const ms = now.getTime() + i * 24 * 60 * 60_000;
    const d = new Date(ms - BUSINESS_OFFSET_MIN * 60_000);
    const dayOfWeek = d.getUTCDay();
    if (!activeDays.has(dayOfWeek)) continue;

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

export type DayStatus = "AVAILABLE" | "FULL" | "BLOCKED";

export interface MonthAvailability {
  month: string; // YYYY-MM
  workingDaysOfWeek: number[]; // 0..6 (0=domingo)
  days: Record<string, DayStatus>; // YYYY-MM-DD -> status, solo si es working day
  durationMin: number;
}

/**
 * Disponibilidad agregada por día para un mes. Se calcula con una sola pasada
 * a la DB (3 queries) y luego se itera localmente para cada fecha del mes.
 */
export async function getMonthlyAvailability(
  monthStr: string,
  durationMin: number,
  excludeAppointmentId?: string,
): Promise<MonthAvailability> {
  const match = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!match) throw new Error(`Mes inválido: ${monthStr}`);
  const year = Number(match[1]);
  const month = Number(match[2]); // 1..12

  // Primer día del mes en GT -> UTC (00:00 GT = 06:00 UTC)
  const monthStart = new Date(Date.UTC(year, month - 1, 1, BUSINESS_OFFSET_MIN / 60));
  const monthEnd = new Date(Date.UTC(year, month, 1, BUSINESS_OFFSET_MIN / 60));

  const [windows, blocks, taken, settings] = await Promise.all([
    prisma.availabilitySlot.findMany({
      where: { active: true },
      orderBy: { startMinute: "asc" },
    }),
    prisma.availabilityBlock.findMany({
      where: { startsAt: { lt: monthEnd }, endsAt: { gt: monthStart } },
    }),
    prisma.appointment.findMany({
      where: {
        scheduledAt: { gte: monthStart, lt: monthEnd },
        status: { in: ["SCHEDULED", "COMPLETED"] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { scheduledAt: true, durationMin: true },
    }),
    getSettings(),
  ]);

  const windowsByDow = new Map<number, typeof windows>();
  for (const w of windows) {
    if (!windowsByDow.has(w.dayOfWeek)) windowsByDow.set(w.dayOfWeek, []);
    windowsByDow.get(w.dayOfWeek)!.push(w);
  }
  const workingDow = Array.from(windowsByDow.keys()).sort();

  const minStart = new Date(Date.now() + settings.minLeadMinutes * 60_000);
  const days: Record<string, DayStatus> = {};

  // Iterar fechas del mes
  let cursor = new Date(monthStart);
  while (cursor < monthEnd) {
    const dayOfWeek = cursor.getUTCDay();
    const dayWindows = windowsByDow.get(dayOfWeek);
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(
      cursor.getUTCDate(),
    ).padStart(2, "0")}`;

    if (!dayWindows) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
      continue;
    }

    const dayStart = cursor;
    const dayEnd = new Date(cursor.getTime() + 24 * 60 * 60_000);

    // Si la config prohíbe mismo día y este día es hoy → marcar FULL y saltar
    if (!settings.allowSameDayBooking && isSameBusinessDay(dayStart)) {
      days[dateStr] = "FULL";
      cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
      continue;
    }

    const dayBlocks = blocks.filter(
      (b) => b.startsAt < dayEnd && b.endsAt > dayStart,
    );
    const dayTaken = taken.filter(
      (a) => a.scheduledAt && a.scheduledAt >= dayStart && a.scheduledAt < dayEnd,
    );

    // ¿Algún slot libre?
    let hasFreeSlot = false;
    outer: for (const w of dayWindows) {
      let m = w.startMinute;
      while (m + durationMin <= w.endMinute) {
        const slotStart = new Date(dayStart.getTime() + m * 60_000);
        const slotEnd = new Date(slotStart.getTime() + durationMin * 60_000);
        const passesLead = slotStart >= minStart;
        const notBlocked = !dayBlocks.some(
          (b) => b.startsAt < slotEnd && b.endsAt > slotStart,
        );
        const notTaken = !dayTaken.some((a) => {
          if (!a.scheduledAt) return false;
          const aEnd = new Date(a.scheduledAt.getTime() + a.durationMin * 60_000);
          return a.scheduledAt < slotEnd && aEnd > slotStart;
        });
        if (passesLead && notBlocked && notTaken) {
          hasFreeSlot = true;
          break outer;
        }
        m += SLOT_INCREMENT_MIN;
      }
    }

    if (hasFreeSlot) {
      days[dateStr] = "AVAILABLE";
    } else {
      // Si TODAS las ventanas del día están cubiertas por bloques → BLOCKED
      const allBlocked = dayWindows.every((w) =>
        dayBlocks.some((b) => {
          const wStart = new Date(dayStart.getTime() + w.startMinute * 60_000);
          const wEnd = new Date(dayStart.getTime() + w.endMinute * 60_000);
          return b.startsAt <= wStart && b.endsAt >= wEnd;
        }),
      );
      days[dateStr] = allBlocked ? "BLOCKED" : "FULL";
    }

    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
  }

  return { month: monthStr, workingDaysOfWeek: workingDow, days, durationMin };
}

/** Valida que un Date caiga dentro de algún slot disponible para ese appointment. */
export async function isValidSlot(
  scheduledAt: Date,
  durationMin: number,
  excludeAppointmentId?: string,
): Promise<boolean> {
  const local = new Date(scheduledAt.getTime() - BUSINESS_OFFSET_MIN * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;

  const slots = await getAvailableSlots({
    date: dateStr,
    durationMin,
    excludeAppointmentId,
  });

  return slots.some((s) => s.getTime() === scheduledAt.getTime());
}
