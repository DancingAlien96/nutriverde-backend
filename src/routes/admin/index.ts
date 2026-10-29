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
import { requireFullAccess } from "../../middlewares/require-admin.js";

const router = Router();

// Login y /me: cualquier rol.
router.use("/auth", authRouter);

// Agenda: cualquier rol autenticado. La secretaria solo tiene esto.
// (Dentro del router se recorta lo que ve según el rol.)
router.use("/appointments", appointmentsRouter);

// Todo lo demás es exclusivo de la nutricionista (y staff): pagos, datos
// bancarios, disponibilidad, servicios, pacientes/expedientes y recordatorios.
router.use("/payments", requireFullAccess, paymentsRouter);
router.use("/payment-settings", requireFullAccess, paymentSettingsRouter);
router.use("/availability", requireFullAccess, availabilityRouter);
router.use("/services", requireFullAccess, servicesRouter);
router.use("/patients", requireFullAccess, patientsRouter);
router.use("/reminders", requireFullAccess, remindersRouter);
router.use("/dashboard", requireFullAccess, dashboardRouter);

// Usuarios del panel: solo la nutricionista (el guard vive dentro del router).
router.use("/users", usersRouter);

export default router;
