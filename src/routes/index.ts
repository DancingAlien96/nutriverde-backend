import { Router } from "express";
import healthRouter from "./health.js";
import servicesRouter from "./services.js";
import intakeRouter from "./intake.js";

const router = Router();

router.use("/health", healthRouter);
router.use("/services", servicesRouter);
router.use("/intake", intakeRouter);

// TODO: agregar a medida que se construyan los flujos
// router.use("/payments", paymentsRouter);
// router.use("/appointments", appointmentsRouter);
// router.use("/admin", adminRouter);

export default router;
