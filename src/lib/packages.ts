import { prisma } from "./prisma.js";

/**
 * Paquetes de sesiones de una paciente con su uso. Las sesiones usadas se
 * cuentan en vivo: citas ligadas al paquete que no estén canceladas (una
 * NO_SHOW sí consume). Así cancelar una cita devuelve la sesión sola.
 */
export interface PackageUsage {
  id: string;
  serviceId: string;
  serviceName: string;
  totalSessions: number;
  usedSessions: number;
  remaining: number;
  createdAt: Date;
  notes: string | null;
}

export async function packagesForPatient(patientId: string): Promise<PackageUsage[]> {
  const packages = await prisma.sessionPackage.findMany({
    where: { patientId },
    orderBy: { createdAt: "desc" },
    include: {
      service: { select: { name: true } },
      appointments: { where: { status: { not: "CANCELED" } }, select: { id: true } },
    },
  });
  return packages.map((p) => {
    const used = p.appointments.length;
    return {
      id: p.id,
      serviceId: p.serviceId,
      serviceName: p.service.name,
      totalSessions: p.totalSessions,
      usedSessions: used,
      remaining: Math.max(0, p.totalSessions - used),
      createdAt: p.createdAt,
      notes: p.notes,
    };
  });
}

/** Resumen del paquete para mostrar junto a cada cita del calendario. */
export interface AppointmentPackageInfo {
  id: string;
  totalSessions: number;
  usedSessions: number;
  /** Posición de esta cita dentro del paquete (1 = primera). null si está cancelada. */
  sessionNumber: number | null;
}

/**
 * Para un conjunto de citas, calcula para las que tienen paquete su número
 * de sesión y el uso total del paquete. Una sola consulta por lote.
 */
export async function packageInfoForAppointments(
  appointments: { id: string; packageId: string | null }[],
): Promise<Map<string, AppointmentPackageInfo>> {
  const result = new Map<string, AppointmentPackageInfo>();
  const packageIds = Array.from(
    new Set(appointments.map((a) => a.packageId).filter((x): x is string => !!x)),
  );
  if (packageIds.length === 0) return result;

  const packages = await prisma.sessionPackage.findMany({
    where: { id: { in: packageIds } },
    select: {
      id: true,
      totalSessions: true,
      appointments: {
        where: { status: { not: "CANCELED" } },
        orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      },
    },
  });

  const byPackage = new Map(packages.map((p) => [p.id, p]));
  for (const a of appointments) {
    if (!a.packageId) continue;
    const p = byPackage.get(a.packageId);
    if (!p) continue;
    const idx = p.appointments.findIndex((x) => x.id === a.id);
    result.set(a.id, {
      id: p.id,
      totalSessions: p.totalSessions,
      usedSessions: p.appointments.length,
      sessionNumber: idx >= 0 ? idx + 1 : null,
    });
  }
  return result;
}
