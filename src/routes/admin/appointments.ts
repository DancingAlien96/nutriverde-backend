import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { sendMail } from "../../lib/mailer.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middlewares/error-handler.js";
import { requireAdmin } from "../../middlewares/require-admin.js";
import { isUtf8, utf8Message } from "../../lib/text.js";
import {
  appointmentCanceledHtml,
  appointmentConfirmedHtml,
  appointmentRescheduledHtml,
  confirmAppointment,
  meetingUrlSchema,
  modalitySchema,
  notifyNutritionists,
  timezoneSchema,
  trySendMail,
} from "../../lib/appointments.js";
import { getAvailableSlots, getMonthlyAvailability, isValidSlot } from "../../lib/scheduling.js";
import { packageInfoForAppointments, packagesForPatient } from "../../lib/packages.js";

const router = Router();
router.use(requireAdmin);

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// Lista las citas con horario asignado (para el calendario del admin).
// Opcionalmente filtra por rango [from, to].
// La secretaria no ve datos de pago: solo paciente, servicio y horario.
router.get("/", async (req, res, next) => {
  try {
    const { from, to } = querySchema.parse(req.query);
    const showPayment = req.admin!.role !== "SECRETARY";

    const scheduledAt: {
      not: null;
      gte?: Date;
      lte?: Date;
    } = { not: null };
    if (from) scheduledAt.gte = new Date(from);
    if (to) scheduledAt.lte = new Date(to);

    const appointments = await prisma.appointment.findMany({
      where: { scheduledAt },
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true,
        scheduledAt: true,
        durationMin: true,
        timezone: true,
        status: true,
        meetingUrl: true,
        meetingProvider: true,
        notes: true,
        packageId: true,
        invoiceStatus: true,
        invoicedAt: true,
        modality: true,
        patient: {
          select: { id: true, fullName: true, email: true, phone: true },
        },
        service: { select: { id: true, name: true } },
        payment: showPayment
          ? {
              select: {
                id: true,
                status: true,
                amountCents: true,
                currency: true,
              },
            }
          : false,
      },
    });

    const pkgInfo = await packageInfoForAppointments(appointments);

    res.json({
      appointments: appointments.map((a) => ({
        ...a,
        payment: "payment" in a ? a.payment : null,
        package: pkgInfo.get(a.id) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Citas con pago aprobado que todavía no están agendadas: o la paciente aún
 * no eligió horario (PAYMENT_APPROVED) o propuso uno y falta confirmarlo con
 * el link de la videollamada (PENDING_CONFIRMATION). Es la "bandeja" de la
 * secretaria.
 */
router.get("/pending", async (_req, res, next) => {
  try {
    const appointments = await prisma.appointment.findMany({
      where: { status: { in: ["PAYMENT_APPROVED", "PENDING_CONFIRMATION"] } },
      orderBy: [{ scheduledAt: "asc" }, { updatedAt: "asc" }],
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        durationMin: true,
        timezone: true,
        scheduleToken: true,
        meetingUrl: true,
        meetingProvider: true,
        modality: true,
        updatedAt: true,
        package: { select: { id: true, totalSessions: true } },
        patient: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            timezone: true,
          },
        },
        service: { select: { id: true, name: true, durationMin: true } },
      },
    });

    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

/**
 * Busca una paciente por correo para la cita manual. Devuelve solo lo que la
 * secretaria necesita para no duplicarla (nombre, teléfono, zona horaria);
 * nada clínico.
 */
router.get("/patient-lookup", async (req, res, next) => {
  try {
    const email = z.string().trim().toLowerCase().email().parse(req.query.email);
    const patient = await prisma.patient.findUnique({
      where: { email },
      select: { id: true, fullName: true, email: true, phone: true, timezone: true },
    });
    // Paquetes con sesiones restantes: la secretaria ve de un vistazo si la
    // cita descuenta de un programa pagado o si hay que cobrar.
    const packages = patient ? await packagesForPatient(patient.id) : [];
    res.json({ patient, packages });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Nombre demasiado corto")
    .max(120)
    .refine(isUtf8, utf8Message("El nombre")),
  email: z.string().trim().toLowerCase().email("Correo inválido"),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  timezone: timezoneSchema.default("America/Guatemala"),
  serviceId: z.string().trim().min(1, "Servicio requerido"),
  // Paquete del que descuenta la cita. Si viene, manda sobre serviceId.
  packageId: z.string().trim().min(1).optional(),
  scheduledAt: z.string().datetime("Fecha y hora requeridas"),
  // Opcional: la cita puede crearse sin enlace y enviarlo después.
  meetingUrl: meetingUrlSchema.optional().or(z.literal("")),
  meetingProvider: z.enum(["GOOGLE_MEET", "ZOOM"]).optional(),
  // Virtual (con enlace) o presencial (sin enlace, aviso un día antes).
  modality: modalitySchema.default("VIRTUAL"),
  notes: z
    .string()
    .trim()
    .max(1000)
    .refine(isUtf8, utf8Message("Las notas"))
    .optional()
    .or(z.literal("")),
});

/**
 * Cita desde cero (sin pasar por el formulario público ni por un pago):
 * la secretaria registra a la paciente (o reutiliza la existente por
 * correo), elige servicio + horario, pega el link y la cita nace ya
 * SCHEDULED. La paciente recibe el mismo correo de confirmación.
 *
 * No se crea registro de pago: el cobro de estas citas se maneja fuera del
 * sistema (o la nutricionista lo registra después). Queda anotado en `notes`
 * quién la creó para poder rastrearla.
 */
router.post("/", async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);

    // Si la cita descuenta de un paquete, validamos que exista, que sea de
    // esta paciente y que le queden sesiones. El servicio es el del paquete.
    let pkg: { id: string; serviceId: string; patientEmail: string; totalSessions: number } | null = null;
    if (input.packageId) {
      const found = await prisma.sessionPackage.findUnique({
        where: { id: input.packageId },
        include: {
          patient: { select: { email: true } },
          appointments: { where: { status: { not: "CANCELED" } }, select: { id: true } },
        },
      });
      if (!found) throw new HttpError(404, "Paquete no encontrado.");
      if (found.patient.email !== input.email) {
        throw new HttpError(400, "Ese paquete pertenece a otra paciente.");
      }
      if (found.appointments.length >= found.totalSessions) {
        throw new HttpError(
          409,
          "Este paquete ya no tiene sesiones disponibles. La paciente debe renovar o pagar una cita individual.",
        );
      }
      pkg = {
        id: found.id,
        serviceId: found.serviceId,
        patientEmail: found.patient.email,
        totalSessions: found.totalSessions,
      };
    }

    const service = await prisma.service.findUnique({
      where: { id: pkg ? pkg.serviceId : input.serviceId },
    });
    if (!service || (!pkg && !service.active)) {
      throw new HttpError(400, "Servicio no disponible.");
    }
    // Los servicios mensuales tienen durationMin 0; para bloquear agenda
    // usamos una hora por defecto.
    const durationMin = service.durationMin > 0 ? service.durationMin : 60;

    const scheduledAt = new Date(input.scheduledAt);
    const ok = await isValidSlot(scheduledAt, durationMin);
    if (!ok) {
      throw new HttpError(409, "Ese horario ya no está disponible. Elige otro.");
    }

    const createdBy = req.admin!.email;
    // Presencial: nunca lleva enlace aunque venga en el cuerpo.
    const createUrl = input.modality === "IN_PERSON" ? null : input.meetingUrl || null;
    const stamp = `Agendada manualmente desde el panel por ${createdBy}.`;
    const notes = input.notes ? `${stamp}\n${input.notes}` : stamp;

    const { patient, appointment, existed, newPackageId } = await prisma.$transaction(async (tx) => {
      // Recuento definitivo dentro de la transacción, con la fila del paquete
      // bloqueada: dos peticiones casi simultáneas no pueden descontar la
      // misma última sesión (la comprobación de arriba es solo para dar un
      // mensaje temprano).
      if (pkg) {
        await tx.$queryRaw`SELECT id FROM session_packages WHERE id = ${pkg.id} FOR UPDATE`;
        const used = await tx.appointment.count({
          where: { packageId: pkg.id, status: { not: "CANCELED" } },
        });
        if (used >= pkg.totalSessions) {
          throw new HttpError(
            409,
            "Este paquete ya no tiene sesiones disponibles. La paciente debe renovar o pagar una cita individual.",
          );
        }
      }

      const existing = await tx.patient.findUnique({ where: { email: input.email } });

      // Si ya existe, no pisamos su nombre: solo completamos lo que falte.
      const patient = existing
        ? await tx.patient.update({
            where: { id: existing.id },
            data: {
              phone: existing.phone ?? (input.phone || null),
              timezone: existing.timezone || input.timezone,
            },
          })
        : await tx.patient.create({
            data: {
              fullName: input.fullName,
              email: input.email,
              phone: input.phone || null,
              timezone: input.timezone,
            },
          });

      // Venta de un programa desde el panel: si la secretaria eligió un
      // servicio de varias sesiones y no está descontando de un paquete
      // existente, se registra el paquete nuevo (sin pago en el sistema) y
      // esta cita queda como su primera sesión.
      let newPackageId: string | null = null;
      if (!pkg && service.sessions > 1) {
        const created = await tx.sessionPackage.create({
          data: {
            patientId: patient.id,
            serviceId: service.id,
            totalSessions: service.sessions,
            notes: `Registrado manualmente desde el panel por ${createdBy}.`,
          },
        });
        newPackageId = created.id;
      }

      const appointment = await tx.appointment.create({
        data: {
          patientId: patient.id,
          serviceId: service.id,
          durationMin,
          timezone: patient.timezone,
          scheduledAt,
          status: "SCHEDULED",
          modality: input.modality,
          meetingUrl: createUrl,
          meetingProvider: createUrl ? input.meetingProvider ?? "GOOGLE_MEET" : null,
          notes,
          packageId: pkg?.id ?? newPackageId,
        },
      });

      return { patient, appointment, existed: !!existing, newPackageId };
    });

    // Correo a la paciente. Se espera el resultado para mostrarlo en pantalla:
    // la cita ya está guardada aunque el correo falle.
    const email = await trySendMail({
      to: patient.email,
      subject: "Cita confirmada — Plenha Nutrition",
      template: "appointment-confirmed",
      html: appointmentConfirmedHtml({
        name: patient.fullName,
        service: service.name,
        when: scheduledAt,
        durationMin,
        patientTimezone: patient.timezone,
        meetingUrl: createUrl,
        modality: input.modality,
      }),
    });

    // Última sesión del paquete: aviso a nutricionista y secretarias para
    // que recuerden a la paciente renovar antes de que se quede sin citas.
    if (pkg) {
      const usedNow = await prisma.appointment.count({
        where: { packageId: pkg.id, status: { not: "CANCELED" } },
      });
      if (usedNow >= pkg.totalSessions) {
        const staff = await prisma.adminUser.findMany({
          where: { active: true, role: { in: ["NUTRITIONIST", "SECRETARY"] } },
          select: { email: true },
        });
        for (const admin of staff) {
          void sendMail({
            to: admin.email,
            subject: `Último paquete agendado: ${patient.fullName}`,
            template: "package-last-session-admin",
            html: packageExhaustedAdminHtml({
              patientName: patient.fullName,
              patientEmail: patient.email,
              service: service.name,
              total: pkg.totalSessions,
              when: scheduledAt,
            }),
          }).catch((err) => console.error("Email paquete agotado falló:", err));
        }
      }
    }

    void notifyNutritionists({ actor: req.admin!, action: "created", appointmentId: appointment.id });

    res.status(201).json({
      ok: true,
      appointment,
      email,
      // Paquete creado en esta misma operación (venta de programa), si aplica.
      packageCreated: newPackageId
        ? { id: newPackageId, totalSessions: service.sessions, serviceName: service.name }
        : null,
      patient: {
        id: patient.id,
        fullName: patient.fullName,
        email: patient.email,
        existed,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Pacientes con el paquete agotado (todas las sesiones ya asignadas) y sin
 * otro paquete con sesiones: la lista "por renovar" de la agenda. Se limita
 * a paquetes cuya última sesión fue hace menos de 45 días (o es futura)
 * para que la lista no crezca sin fin.
 */
router.get("/renewals", async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 45 * 24 * 60 * 60_000);
    const packages = await prisma.sessionPackage.findMany({
      include: {
        patient: { select: { id: true, fullName: true, email: true, phone: true } },
        service: { select: { name: true } },
        appointments: {
          where: { status: { not: "CANCELED" } },
          orderBy: { scheduledAt: "asc" },
          select: { scheduledAt: true },
        },
      },
    });

    // Si la paciente ya tiene otro paquete con sesiones, ya renovó.
    const renewed = new Set(
      packages
        .filter((p) => p.appointments.length < p.totalSessions)
        .map((p) => p.patientId),
    );

    const renewals = packages
      .filter((p) => p.appointments.length >= p.totalSessions && !renewed.has(p.patientId))
      .map((p) => {
        const dates = p.appointments.map((a) => a.scheduledAt).filter((d): d is Date => !!d);
        const lastSessionAt = dates.length ? dates[dates.length - 1] : null;
        return {
          packageId: p.id,
          patient: p.patient,
          serviceName: p.service.name,
          totalSessions: p.totalSessions,
          lastSessionAt,
          lastSessionDone: lastSessionAt ? lastSessionAt < new Date() : false,
        };
      })
      .filter((r) => !r.lastSessionAt || r.lastSessionAt >= since)
      .sort((a, b) => (b.lastSessionAt?.getTime() ?? 0) - (a.lastSessionAt?.getTime() ?? 0));

    res.json({ renewals });
  } catch (err) {
    next(err);
  }
});

const invoiceSchema = z.object({
  status: z.enum(["PENDING", "ISSUED", "NOT_REQUESTED"]),
});

/**
 * Estado de facturación de una cita: pendiente, factura emitida o la
 * paciente no la solicitó. Es solo un control administrativo (no genera
 * documentos); lo usan secretaria y nutricionista.
 */
router.patch("/:id/invoice", async (req, res, next) => {
  try {
    const { status } = invoiceSchema.parse(req.body);
    const exists = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!exists) throw new HttpError(404, "Cita no encontrada.");

    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { invoiceStatus: status, invoicedAt: status === "ISSUED" ? new Date() : null },
      select: { id: true, invoiceStatus: true, invoicedAt: true },
    });
    res.json({ ok: true, appointment });
  } catch (err) {
    next(err);
  }
});

async function loadSchedulable(id: string) {
  const appt = await prisma.appointment.findUnique({
    where: { id },
    select: { id: true, durationMin: true, status: true },
  });
  if (!appt) throw new HttpError(404, "Cita no encontrada.");
  return appt;
}

// Disponibilidad por día de un mes para esta cita (excluyéndola a sí misma,
// por si ya tiene un horario propuesto que ocupa su propio hueco).
router.get("/:id/availability", async (req, res, next) => {
  try {
    const appt = await loadSchedulable(req.params.id);
    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/, "Formato esperado YYYY-MM")
      .parse(req.query.month);

    const data = await getMonthlyAvailability(month, appt.durationMin, appt.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Horas libres de un día concreto para esta cita.
router.get("/:id/slots", async (req, res, next) => {
  try {
    const appt = await loadSchedulable(req.params.id);
    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado YYYY-MM-DD")
      .parse(req.query.date);

    const slots = await getAvailableSlots({
      date,
      durationMin: appt.durationMin,
      excludeAppointmentId: appt.id,
    });

    res.json({
      date,
      durationMin: appt.durationMin,
      slots: slots.map((s) => s.toISOString()),
    });
  } catch (err) {
    next(err);
  }
});

const confirmSchema = z.object({
  // Opcional: se puede confirmar sin enlace y mandarlo después.
  meetingUrl: meetingUrlSchema.optional().or(z.literal("")),
  meetingProvider: z.enum(["GOOGLE_MEET", "ZOOM"]).optional(),
  modality: modalitySchema.optional(),
  // Obligatorio si la cita no tiene horario propuesto; opcional para ajustar.
  scheduledAt: z.string().datetime().optional(),
});

/**
 * Agenda la cita: fija horario (si se manda) + link y envía el correo de
 * confirmación a la paciente. Mismo comportamiento que
 * POST /admin/payments/:id/confirm-appointment, pero por id de cita para que
 * la secretaria no necesite entrar al detalle del pago.
 */
router.post("/:id/confirm", async (req, res, next) => {
  try {
    const { meetingUrl, meetingProvider, modality, scheduledAt } = confirmSchema.parse(req.body);

    const { appointment, email } = await confirmAppointment({
      appointmentId: req.params.id,
      meetingUrl: meetingUrl || null,
      meetingProvider,
      modality,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
    });

    void notifyNutritionists({ actor: req.admin!, action: "confirmed", appointmentId: appointment.id });

    res.json({ ok: true, appointment, email });
  } catch (err) {
    next(err);
  }
});

const declineSchema = z.object({
  // Motivo opcional que se le muestra a la paciente. Sin esto solo recibiria
  // un "no puedo" sin contexto, que se siente peor que un rechazo explicado.
  reason: z
    .string()
    .trim()
    .max(500)
    .refine(isUtf8, utf8Message("El motivo"))
    .optional()
    .or(z.literal("")),
});

/**
 * La nutricionista no puede atender el horario que la paciente eligio.
 *
 * Devuelve la cita al estado "pago aprobado, falta horario" y le reenvia el
 * link de auto-agenda. Reutiliza el scheduleToken que ya existe para que el
 * enlace no cambie; si la cita ya estaba confirmada y no tiene token (caso de
 * las creadas antes de este flujo), se genera uno.
 *
 * No toca el pago: el dinero sigue acreditado y la consulta sigue viva, solo
 * se mueve la fecha.
 */
router.post("/:id/decline-time", async (req, res, next) => {
  try {
    const { reason } = declineSchema.parse(req.body);

    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true, payment: true },
    });
    if (!appt) throw new HttpError(404, "Cita no encontrada.");

    if (!appt.scheduledAt) {
      throw new HttpError(
        409,
        "Esta cita todavía no tiene horario que rechazar.",
      );
    }
    if (appt.status !== "PENDING_CONFIRMATION" && appt.status !== "SCHEDULED") {
      throw new HttpError(
        409,
        "Solo se puede rechazar el horario de una cita propuesta o ya agendada.",
      );
    }
    if (appt.payment && appt.payment.status !== "APPROVED") {
      throw new HttpError(
        409,
        "El pago de esta cita no está aprobado; no hay horario que reprogramar.",
      );
    }

    const scheduleToken =
      appt.scheduleToken ?? crypto.randomBytes(24).toString("hex");
    const rejectedWhen = appt.scheduledAt;

    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        // Se limpia el horario para que el slot vuelva a quedar libre para
        // otras pacientes mientras esta elige uno nuevo.
        scheduledAt: null,
        status: "PAYMENT_APPROVED",
        scheduleToken,
        // El link de la reunion pertenecia al horario descartado.
        meetingUrl: null,
        meetingProvider: null,
      },
    });

    void sendMail({
      to: appt.patient.email,
      subject: "Necesitamos reprogramar tu cita — Plenha Nutrition",
      template: "appointment-time-declined",
      html: timeDeclinedHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        when: rejectedWhen,
        patientTimezone: appt.patient.timezone,
        reason: reason || null,
        scheduleUrl: `${env.PUBLIC_BASE_URL}/agendar-cita/${scheduleToken}`,
      }),
    }).catch((err) => console.error("Email de reprogramación falló:", err));

    void notifyNutritionists({
      actor: req.admin!,
      action: "declined",
      appointmentId: updated.id,
      reason: reason || null,
      previous: rejectedWhen,
    });

    res.json({ ok: true, appointment: updated });
  } catch (err) {
    next(err);
  }
});

const cancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .refine(isUtf8, utf8Message("El motivo"))
    .optional()
    .or(z.literal("")),
});

/**
 * Cancela una cita con horario. Conserva la fecha para que quede en el
 * calendario tachada (historial), pero el slot queda libre porque la
 * disponibilidad solo cuenta SCHEDULED/COMPLETED. No toca el pago: si la
 * paciente quiere otra fecha, se usa "reprogramar" sobre esta misma cita.
 */
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const { reason } = cancelSchema.parse(req.body);

    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true },
    });
    if (!appt) throw new HttpError(404, "Cita no encontrada.");
    if (!appt.scheduledAt) {
      throw new HttpError(409, "Esta cita no tiene horario; no hay nada que cancelar.");
    }
    if (appt.status !== "SCHEDULED" && appt.status !== "PENDING_CONFIRMATION") {
      throw new HttpError(409, "Solo se puede cancelar una cita confirmada o propuesta.");
    }

    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: "CANCELED" },
    });

    void sendMail({
      to: appt.patient.email,
      subject: "Tu cita fue cancelada — Plenha Nutrition",
      template: "appointment-canceled",
      html: appointmentCanceledHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        when: appt.scheduledAt,
        patientTimezone: appt.patient.timezone,
        reason: reason || null,
      }),
    }).catch((err) => console.error("Email cancelación falló:", err));

    void notifyNutritionists({
      actor: req.admin!,
      action: "canceled",
      appointmentId: updated.id,
      reason: reason || null,
    });

    res.json({ ok: true, appointment: updated });
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({
  scheduledAt: z.string().datetime("Fecha y hora requeridas"),
  // Opcional: si cambia el enlace. Si no viene, se conserva el que había.
  meetingUrl: meetingUrlSchema.optional(),
  meetingProvider: z.enum(["GOOGLE_MEET", "ZOOM"]).optional(),
  modality: modalitySchema.optional(),
});

/**
 * Mueve una cita a otro horario y avisa a la paciente. Sirve tanto para una
 * cita confirmada como para reactivar una cancelada (vuelve a SCHEDULED sin
 * nuevo pago), que es el caso "la paciente canceló y luego quiere otra fecha".
 */
router.post("/:id/reschedule", async (req, res, next) => {
  try {
    const { scheduledAt, meetingUrl, meetingProvider, modality } = rescheduleSchema.parse(req.body);

    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true, service: true, payment: true },
    });
    if (!appt) throw new HttpError(404, "Cita no encontrada.");
    if (appt.status !== "SCHEDULED" && appt.status !== "CANCELED") {
      throw new HttpError(409, "Solo se puede reprogramar una cita confirmada o cancelada.");
    }
    if (appt.payment && appt.payment.status !== "APPROVED") {
      throw new HttpError(409, "El pago de esta cita no está aprobado.");
    }

    const when = new Date(scheduledAt);
    const ok = await isValidSlot(when, appt.durationMin, appt.id);
    if (!ok) throw new HttpError(409, "Ese horario ya no está disponible. Elige otro.");

    const finalModality = modality ?? appt.modality;
    const finalUrl = finalModality === "IN_PERSON" ? null : meetingUrl ?? appt.meetingUrl;
    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        scheduledAt: when,
        status: "SCHEDULED",
        modality: finalModality,
        meetingUrl: finalUrl,
        meetingProvider: finalUrl ? meetingProvider ?? appt.meetingProvider ?? "GOOGLE_MEET" : null,
      },
    });

    void sendMail({
      to: appt.patient.email,
      subject: "Tu cita cambió de horario — Plenha Nutrition",
      template: "appointment-rescheduled",
      html: appointmentRescheduledHtml({
        name: appt.patient.fullName,
        service: appt.service.name,
        previous: appt.status === "SCHEDULED" ? appt.scheduledAt : null,
        when,
        durationMin: appt.durationMin,
        patientTimezone: appt.patient.timezone,
        meetingUrl: finalUrl,
        modality: finalModality,
      }),
    }).catch((err) => console.error("Email reprogramación falló:", err));

    void notifyNutritionists({
      actor: req.admin!,
      action: "rescheduled",
      appointmentId: updated.id,
      previous: appt.status === "SCHEDULED" ? appt.scheduledAt : null,
    });

    res.json({ ok: true, appointment: updated });
  } catch (err) {
    next(err);
  }
});

function timeDeclinedHtml(opts: {
  name: string;
  service: string;
  when: Date;
  patientTimezone: string;
  reason: string | null;
  scheduleUrl: string;
}): string {
  const localTime = opts.when.toLocaleString("es-GT", {
    timeZone: opts.patientTimezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h1 style="color: #687445; font-size: 22px;">Hola ${escapeHtml(opts.name)},</h1>
      <p>Lamentamos avisarte que no podremos atenderte en el horario que elegiste para tu <strong>${escapeHtml(opts.service)}</strong>:</p>
      <p style="background: #f3f4f6; border-radius: 8px; padding: 12px 16px; color: #6b7280; text-decoration: line-through;">${escapeHtml(localTime)}</p>
      ${
        opts.reason
          ? `<p><strong>Motivo:</strong> ${escapeHtml(opts.reason)}</p>`
          : ""
      }
      <p><strong>Tu pago sigue confirmado</strong> y tu consulta está reservada. Solo necesitamos que elijas otro horario:</p>
      <p style="margin: 24px 0;">
        <a href="${opts.scheduleUrl}" style="background: #687445; color: #ffffff; padding: 12px 24px; border-radius: 999px; text-decoration: none; display: inline-block;">Elegir otro horario</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Si ninguno de los horarios disponibles te funciona, responde este correo y lo resolvemos.</p>
      <p style="margin-top: 32px; color: #6b7280; font-size: 13px;">— Plenha Nutrition</p>
    </div>
  `;
}

/** Aviso interno: se agendó la última sesión de un paquete. */
function packageExhaustedAdminHtml(opts: {
  patientName: string;
  patientEmail: string;
  service: string;
  total: number;
  when: Date;
}): string {
  const whenGt = opts.when.toLocaleString("es-GT", {
    timeZone: "America/Guatemala",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
      <h2>Se agendó la última sesión de un paquete</h2>
      <ul style="line-height: 1.8;">
        <li><strong>Paciente:</strong> ${escapeHtml(opts.patientName)} (${escapeHtml(opts.patientEmail)})</li>
        <li><strong>Paquete:</strong> ${escapeHtml(opts.service)} · sesión ${opts.total} de ${opts.total}</li>
        <li><strong>Fecha de esa sesión:</strong> ${escapeHtml(whenGt)}</li>
      </ul>
      <p>Después de esta cita la paciente no tendrá sesiones disponibles. Conviene recordarle que renueve el programa o pague una cita individual. Aparece en la lista "Por renovar" de la agenda.</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default router;
