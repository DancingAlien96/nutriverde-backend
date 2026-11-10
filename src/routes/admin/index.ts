import { Router } from "express";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";
import paymentSettingsRouter from "./payment-settings.js";
import availabilityRouter from "./availability.js";
import servicesRouter from "./services.js";
import patientsRouter from "./patients.js";
import remindersRouter from "./reminders.js";
import appointmentsRouter from "./appointments.js";
import usersRouter from "./users.js";
import dashboardRouter from "./dashboard.js";
import chargesRouter from "./charges.js";
import pushRouter from "./push.js";
import { requireFullAccess } from "../../middlewares/require-admin.js";

const router = Router();

// Login y /me: cualquier rol.
router.use("/auth", authRouter);

// Agenda: cualquier rol autenticado. La secretaria solo tiene esto.
// (Dentro del router se recorta lo que ve según el rol.)
router.use("/appointments", appointmentsRouter);

// Cobros y abonos de lo agendado desde el panel: cualquier rol (la
// secretaria cobra en recepción). Editar precio y borrar abonos se limita
// dentro del router.
router.use("/charges", chargesRouter);

// Notificaciones push de la app instalada: cualquier rol.
router.use("/push", pushRouter);

// Todo lo demás es exclusivo de la nutricionista (y staff): pagos, datos
// bancarios, disponibilidad, servicios, pacientes/expedientes y recordatorios.
router.use("/payments", requireFullAccess, paymentsRouter);
router.use("/payment-settings", requireFullAccess, paymentSettingsRouter);
// Disponibilidad y pacientes: también la secretaria, con la sección de
// pacientes completa (expediente clínico incluido) y permiso de eliminar.
router.use("/availability", availabilityRouter);
router.use("/services", requireFullAccess, servicesRouter);
router.use("/patients", patientsRouter);
router.use("/reminders", requireFullAccess, remindersRouter);
router.use("/dashboard", requireFullAccess, dashboardRouter);

// Usuarios del panel: solo la nutricionista (el guard vive dentro del router).
router.use("/users", usersRouter);

export default router;
