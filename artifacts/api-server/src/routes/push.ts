import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { getDb, pushDevicesTable } from "@workspace/db";
import {
  ListPushDevicesResponse,
  RegisterPushDeviceBody,
  RegisterPushDeviceResponse,
  UnregisterPushDeviceBody,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import { isUuid } from "../lib/uuid";

// Expo push-token registry for the mobile companion app. Devices belong to
// the signed-in platform user; the tenant firm and client Party of the
// registering principal are snapshotted so alert fan-out can resolve devices
// per client (see modules/push/push.ts). A push token is globally unique —
// re-registering moves it to the current user, so a shared device always
// notifies whoever signed in last.
//
// These routes live under the SME namespace (/sme/push/*): every handler
// enforces the same capability gate ("invoice.read" — the baseline SME compliance-monitoring
// capability) so roles outside the SME surface (bank_user, buyer_user) cannot
// touch the device registry, and rows are user-owned (every query is scoped to
// req.principal.userId). Tenant isolation is additionally enforced at the data
// layer by RLS on push_devices (lib/db migration 0003).

const router: IRouter = Router();

// The dev x-mock header shim can carry a non-UUID userId ("dev-user"); those
// principals cannot own device rows (user_id is a UUID foreign key).

router.get("/sme/push/devices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  if (!isUuid(req.principal.userId)) {
    res.json(ListPushDevicesResponse.parse([]));
    return;
  }
  const rows = await getDb()
    .select()
    .from(pushDevicesTable)
    .where(eq(pushDevicesTable.userId, req.principal.userId))
    .orderBy(desc(pushDevicesTable.updatedAt));
  res.json(ListPushDevicesResponse.parse(rows));
});

router.post("/sme/push/devices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const parsed = parseOrThrow(RegisterPushDeviceBody, req.body);
  if (!isUuid(req.principal.userId)) {
    res.status(400).json({
      error: "Push registration requires a real user session",
    });
    return;
  }
  const [row] = await getDb()
    .insert(pushDevicesTable)
    .values({
      userId: req.principal.userId,
      firmId: req.principal.firmId,
      clientPartyId: req.principal.clientPartyId,
      expoPushToken: parsed.expoPushToken,
      platform: parsed.platform,
    })
    .onConflictDoUpdate({
      target: pushDevicesTable.expoPushToken,
      set: {
        userId: req.principal.userId,
        firmId: req.principal.firmId,
        clientPartyId: req.principal.clientPartyId,
        platform: parsed.platform,
        updatedAt: new Date(),
      },
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: req.principal.firmId,
    action: "push.device.register",
    entityType: "push_device",
    entityId: row.id,
    after: { platform: parsed.platform },
  });
  res.json(RegisterPushDeviceResponse.parse(row));
});

// Idempotent removal (sign-out or notifications toggled off). Only the owning
// user can remove a token; unknown tokens still return 204.
router.post("/sme/push/devices/unregister", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const parsed = parseOrThrow(UnregisterPushDeviceBody, req.body);
  if (!isUuid(req.principal.userId)) {
    res.sendStatus(204);
    return;
  }
  const removed = await getDb()
    .delete(pushDevicesTable)
    .where(
      and(
        eq(pushDevicesTable.expoPushToken, parsed.expoPushToken),
        eq(pushDevicesTable.userId, req.principal.userId),
      ),
    )
    .returning({ id: pushDevicesTable.id });
  if (removed.length > 0) {
    await appendAudit({
      actorId: req.principal.userId,
      firmId: req.principal.firmId,
      action: "push.device.unregister",
      entityType: "push_device",
      entityId: removed[0].id,
    });
  }
  res.sendStatus(204);
});

export default router;
