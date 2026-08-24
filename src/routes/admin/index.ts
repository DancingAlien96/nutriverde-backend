import { Router } from "express";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";
import paymentSettingsRouter from "./payment-settings.js";
import availabilityRouter from "./availability.js";
import servicesRouter from "./services.js";
import patientsRouter from "./patients.js";
import remindersRouter from "./reminders.js";
import appointmentsRouter from "./appointments.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/payments", paymentsRouter);
router.use("/payment-settings", paymentSettingsRouter);
router.use("/availability", availabilityRouter);
router.use("/services", servicesRouter);
router.use("/patients", patientsRouter);
router.use("/reminders", remindersRouter);
router.use("/appointments", appointmentsRouter);

export default router;
