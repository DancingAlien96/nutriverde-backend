import { Router } from "express";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";
import availabilityRouter from "./availability.js";
import servicesRouter from "./services.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/payments", paymentsRouter);
router.use("/availability", availabilityRouter);
router.use("/services", servicesRouter);

export default router;
