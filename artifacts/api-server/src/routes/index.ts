import { Router, type IRouter } from "express";
import healthRouter from "./health";
import identityRouter from "./identity";
import partiesRouter from "./parties";
import consentRouter from "./consent";
import engagementsRouter from "./engagements";
import invoicesRouter from "./invoices";
import verificationRouter from "./verification";
import messagingRouter from "./messaging";
import platformRouter from "./platform";
import operatorRouter from "./operator";
import auditRouter from "./audit";
import advisoryRouter from "./advisory";
import catalogueRouter from "./catalogue";

const router: IRouter = Router();

router.use(healthRouter);
router.use(identityRouter);
router.use(partiesRouter);
router.use(consentRouter);
router.use(engagementsRouter);
router.use(invoicesRouter);
router.use(verificationRouter);
router.use(messagingRouter);
router.use(platformRouter);
router.use(operatorRouter);
router.use(auditRouter);
router.use(advisoryRouter);
router.use(catalogueRouter);

export default router;
