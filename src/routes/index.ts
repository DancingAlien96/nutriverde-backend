import { Router } from "express";
import healthRouter from "./health.js";
import servicesRouter from "./services.js";
import intakeRouter from "./intake.js";
import scheduleRouter from "./schedule.js";
import paymentSettingsRouter from "./payment-settings.js";
import adminRouter from "./admin/index.js";

const router = Router();

router.use("/health", healthRouter);
router.use("/services", servicesRouter);
router.use("/intake", intakeRouter);
router.use("/schedule", scheduleRouter);
router.use("/payment-settings", paymentSettingsRouter);
router.use("/admin", adminRouter);

export default router;
