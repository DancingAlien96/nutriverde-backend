import webpush from "web-push";
import type { AdminRole } from "@prisma/client";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";

/**
 * Notificaciones push del panel (Web Push + VAPID). Complementan al correo:
 * los mismos avisos que hoy llegan por email a la nutricionista y a la
 * secretaria llegan también al teléfono o la computadora donde activaron
 * las notificaciones en la app instalada.
 *
 * Si las llaves VAPID no están configuradas, todo esto es un no-op: el
 * panel ofrece activarlas solo cuando GET /admin/push/public-key da llave.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Ruta del panel que se abre al tocar la notificación (p. ej. /admin/citas). */
  url?: string;
  /** Agrupa notificaciones del mismo asunto (la nueva reemplaza a la anterior). */
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Suscripciones caducadas que se borraron (el navegador las dio de baja). */
  removed: number;
}

let configured = false;

export function pushEnabled(): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function ensureConfigured(): boolean {
  if (!pushEnabled()) return false;
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return true;
}

/**
 * Servicios push de los navegadores que usa el personal: Chrome, Edge,
 * Brave, Samsung y Opera (FCM), Firefox (Mozilla), Safari e iPhone (Apple)
 * y Edge/Windows (WNS). Se compara el host exacto o como subdominio.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/**
 * Un endpoint push valido es una URL https de uno de esos servicios. Asi
 * una cuenta del panel no puede registrar una direccion propia y usar el
 * servidor como puente hacia otras redes (SSRF), ni siquiera con un nombre
 * publico que resuelva a una IP interna. Se valida al suscribir y otra vez
 * antes de enviar.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

type SubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string; createdAt: Date };

/** Una suscripcion recien creada puede dar 410 unos segundos mientras el servicio push la propaga: no se borra tan pronto. */
const GRACE_MS = 2 * 60_000;

async function sendToSubscriptions(
  subs: SubscriptionRow[],
  payload: PushPayload,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (subs.length === 0 || !ensureConfigured()) return result;

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  const ok: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        dead.push(s.id);
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60, urgency: "high" },
        );
        ok.push(s.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: el navegador dio de baja la suscripción. Se borra para no
        // insistir en cada aviso.
        const recent = Date.now() - s.createdAt.getTime() < GRACE_MS;
        if ((status === 404 || status === 410) && !recent) dead.push(s.id);
        else {
          result.failed += 1;
          console.error("Push falló:", status ?? "", (err as Error).message);
        }
      }
    }),
  );

  if (ok.length) {
    result.sent = ok.length;
    await prisma.pushSubscription
      .updateMany({ where: { id: { in: ok } }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  if (dead.length) {
    result.removed = dead.length;
    await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } }).catch(() => undefined);
  }
  return result;
}

/**
 * Envía a todas las usuarias activas con esos roles (todos sus
 * dispositivos), opcionalmente sin quien hizo la acción. Nunca lanza.
 */
export async function pushToRoles(
  roles: AdminRole[],
  payload: PushPayload,
  opts: { excludeAdminId?: string } = {},
): Promise<PushResult> {
  try {
    if (!pushEnabled()) return { sent: 0, failed: 0, removed: 0 };
    const subs = await prisma.pushSubscription.findMany({
      where: {
        adminUser: {
          active: true,
          role: { in: roles },
          ...(opts.excludeAdminId ? { id: { not: opts.excludeAdminId } } : {}),
        },
      },
      select: { id: true, endpoint: true, p256dh: true, auth: true, createdAt: true },
    });
    return await sendToSubscriptions(subs, payload);
  } catch (err) {
    console.error("Push a roles falló:", err);
    return { sent: 0, failed: 0, removed: 0 };
  }
}

/** Envía a todos los dispositivos de una usuaria. Nunca lanza. */
export async function pushToAdmin(adminId: string, payload: PushPayload): Promise<PushResult> {
  try {
    if (!pushEnabled()) return { sent: 0, failed: 0, removed: 0 };
    const subs = await prisma.pushSubscription.findMany({
      where: { adminUserId: adminId },
      select: { id: true, endpoint: true, p256dh: true, auth: true, createdAt: true },
    });
    return await sendToSubscriptions(subs, payload);
  } catch (err) {
    console.error("Push a usuaria falló:", err);
    return { sent: 0, failed: 0, removed: 0 };
  }
}

/** Fecha corta en hora de Guatemala para el cuerpo de la notificación. */
export function pushWhen(d: Date | null | undefined): string {
  if (!d) return "sin horario";
  return d.toLocaleString("es-GT", {
    timeZone: "America/Guatemala",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
