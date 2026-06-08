import { Router } from "express";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";
import availabilityRouter from "./availability.js";
import servicesRouter from "./services.js";
import patientsRouter from "./patients.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/payments", paymentsRouter);
router.use("/availability", availabilityRouter);
router.use("/services", servicesRouter);
router.use("/patients", patientsRouter);

export default router;
