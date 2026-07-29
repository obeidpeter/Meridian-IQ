import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sweepRouter from "./sweep";
import authRouter from "./auth";
import identityRouter from "./identity";
import invitationsRouter from "./invitations";
import partiesRouter from "./parties";
import consentRouter from "./consent";
import engagementsRouter from "./engagements";
import invoicesRouter from "./invoices";
// Supplier payables: buyer-side bill access lives on its own router — the
// invoice routes' SEC-03 loaders stay supplier-pinned.
import billsRouter from "./bills";
// Compliance round: VAT position (client + firm rollup), firm governance
// policies (maker-checker), collection accounts (incl. the fail-closed
// inbound payment webhook).
import vatPositionRouter from "./vat-position";
import firmPoliciesRouter from "./firm-policies";
import collectionsRouter from "./collections";
import compliancePackRouter from "./compliance-pack";
import recurringRouter from "./recurring";
import verificationRouter from "./verification";
import messagingRouter from "./messaging";
import platformRouter from "./platform";
import operatorRouter from "./operator";
import auditRouter from "./audit";
import advisoryRouter from "./advisory";
import catalogueRouter from "./catalogue";
import smeRouter from "./sme";
import pushRouter from "./push";
import consoleRouter from "./console";
import statementsRouter from "./statements";
import statementConnectionsRouter from "./statement-connections";
import buyerRouter from "./buyer";
import b2cRouter from "./b2c";
import whitelabelRouter from "./whitelabel";
import certificationRouter from "./certification";
import connectorsRouter from "./connectors";
import claimsRouter from "./claims";
import clerkRouter from "./clerk";
import staffRouter from "./staff";
import billingPaymentsRouter from "./billing-payments";
// Also registers the webhook fan-out/dispatch sweep with the pipeline worker
// (modules/integrations/webhooks.ts registerSweep at import time).
import integrationsRouter from "./integrations";
// Client lifecycle: single-client creation, data-subject export, offboarding.
import clientsRouter from "./clients";
// Registers the INT-02 unmapped-code sweep with the pipeline worker.
import "../modules/desk/sweeps";
// Platform health watch (rails / dead letters / dead deliveries). Also
// reached transitively via routes/operator.ts's constant imports; the
// explicit import keeps sweep registration visible in one place.
import "../modules/desk/health-watch";
import "../modules/desk/triage";
import "../modules/clerk/watchdog";
import "../modules/clerk/eval-growth";
import "../modules/clerk/digest";
import "../modules/clerk/client-statement";
import "../modules/clerk/red-team";
import "../modules/clerk/resistance-watch";
import "../modules/clerk/phrasing-watch";
import "../modules/clerk/spend-watch";
import "../modules/clerk/quality-watch";
import "../modules/push/register";
import "../modules/invoice/register";
import "../modules/messaging/retention";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sweepRouter);
router.use(authRouter);
router.use(identityRouter);
router.use(invitationsRouter);
router.use(partiesRouter);
router.use(consentRouter);
router.use(engagementsRouter);
router.use(invoicesRouter);
router.use(billsRouter);
router.use(vatPositionRouter);
router.use(firmPoliciesRouter);
router.use(collectionsRouter);
router.use(compliancePackRouter);
router.use(recurringRouter);
router.use(verificationRouter);
router.use(messagingRouter);
router.use(platformRouter);
router.use(operatorRouter);
router.use(auditRouter);
router.use(advisoryRouter);
router.use(catalogueRouter);
router.use(smeRouter);
router.use(pushRouter);
router.use(consoleRouter);
router.use(statementsRouter);
router.use(statementConnectionsRouter);
router.use(buyerRouter);
router.use(b2cRouter);
router.use(whitelabelRouter);
router.use(certificationRouter);
router.use(connectorsRouter);
router.use(claimsRouter);
router.use(clerkRouter);
router.use(staffRouter);
router.use(billingPaymentsRouter);
router.use(integrationsRouter);
router.use(clientsRouter);

export default router;
