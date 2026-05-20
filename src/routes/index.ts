import { Router } from "express";
import healthRouter from "./health.js";
import servicesRouter from "./services.js";
import intakeRouter from "./intake.js";
import adminRouter from "./admin/index.js";

const router = Router();

router.use("/health", healthRouter);
router.use("/services", servicesRouter);
router.use("/intake", intakeRouter);
router.use("/admin", adminRouter);

// TODO: agregar a medida que se construyan los flujos
// router.use("/appointments", appointmentsRouter);

export default router;
