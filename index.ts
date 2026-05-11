import { Router, type IRouter } from "express";
import escrowRouter from "./escrow";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/escrow", escrowRouter);

export default router;
