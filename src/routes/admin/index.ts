import { Router } from "express";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/payments", paymentsRouter);

export default router;
