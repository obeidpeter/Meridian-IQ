import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  consentRecordsTable,
  getDb,
  runInBypassContext,
  partiesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  captureFirstLandingConsent,
  hasConsentDecision,
  hasConsentDecisions,
  hasLayerConsent,
  recordConsent,
} from "./consent.ts";
import { DomainError } from "../errors.ts";
import { consentCapturedFor } from "../../routes/identity.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// CORE-03 first-landing capture (D15): "captured" means the business has
// DECIDED on both explicit layers — a recorded decline counts, permission does
// not follow. The pair is one idempotent, all-or-none command.
const SALT = makeRunSalt();
const undecided = randomUUID();
const declined = randomUUID();
const granted = randomUUID();
const partial = randomUUID();

before(async () => {
  await runInBypassContext(async () => {
    await getDb()
      .insert(partiesTable)
      .values(
        [undecided, declined, granted, partial].map((id, i) => ({
          id,
          type: "client_business" as const,
          legalName: `Consent decision ${i} ${SALT}`,
          countryCode: "NG",
        })),
      );
    await captureFirstLandingConsent({
      partyId: declined,
      commandId: randomUUID(),
      decisions: [
        { layer: 1, action: "revoke" },
        { layer: 2, action: "revoke" },
      ],
      actorId: randomUUID(),
    });
    await captureFirstLandingConsent({
      partyId: granted,
      commandId: randomUUID(),
      decisions: [
        { layer: 1, action: "grant" },
        { layer: 2, action: "grant" },
      ],
      actorId: randomUUID(),
    });
    await recordConsent({
      partyId: partial,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "consent",
      channel: "first_landing",
    });
  });
});

test("a business with no layer-1 event is undecided; any event, grant or decline, decides it", async () => {
  await runInBypassContext(async () => {
    assert.equal(await hasConsentDecision(undecided, 1), false);
    assert.equal(await hasConsentDecision(declined, 1), true);
    assert.equal(await hasConsentDecision(granted, 1), true);
    // A decline decides without permitting: the purpose gate stays closed.
    assert.equal(await hasLayerConsent(declined, 1), false);
    assert.equal(await hasLayerConsent(granted, 1), true);
    assert.equal(await hasConsentDecision(granted, 2), true);
    assert.equal(await hasConsentDecisions(granted, [1, 2]), true);
    assert.equal(await hasConsentDecisions(partial, [1, 2]), false);
  });
});

test("Me.consentCaptured: client users answer for their business, every other role answers null", async () => {
  await runInBypassContext(async () => {
    assert.equal(
      await consentCapturedFor({
        role: "client_user",
        clientPartyId: undecided,
      }),
      false,
    );
    assert.equal(
      await consentCapturedFor({
        role: "client_user",
        clientPartyId: declined,
      }),
      true,
    );
    assert.equal(
      await consentCapturedFor({ role: "client_user", clientPartyId: partial }),
      false,
    );
    assert.equal(
      await consentCapturedFor({ role: "firm_staff", clientPartyId: null }),
      null,
    );
    assert.equal(
      await consentCapturedFor({ role: "firm_admin", clientPartyId: granted }),
      null,
    );
    // A dev-header scope that names no real party never blocks a landing on a
    // lookup it cannot make.
    assert.equal(
      await consentCapturedFor({
        role: "client_user",
        clientPartyId: "dev-scope",
      }),
      false,
    );
  });
});

test("first-landing capture is idempotent and rejects command reuse with different decisions", async () => {
  const partyId = randomUUID();
  const commandId = randomUUID();
  await runInBypassContext(async () => {
    await getDb()
      .insert(partiesTable)
      .values({
        id: partyId,
        type: "client_business",
        legalName: `Consent idempotency ${SALT}`,
        countryCode: "NG",
      });
    const decisions = [
      { layer: 1 as const, action: "grant" as const },
      { layer: 2 as const, action: "revoke" as const },
    ];
    const first = await captureFirstLandingConsent({
      partyId,
      commandId,
      decisions,
    });
    const retry = await captureFirstLandingConsent({
      partyId,
      commandId,
      decisions,
    });
    assert.deepEqual(
      retry.map((row) => row.id),
      first.map((row) => row.id),
    );
    const stored = await getDb()
      .select()
      .from(consentRecordsTable)
      .where(
        and(
          eq(consentRecordsTable.partyId, partyId),
          eq(consentRecordsTable.commandId, commandId),
        ),
      );
    assert.equal(stored.length, 2, "a retry never appends duplicate decisions");

    await assert.rejects(
      () =>
        captureFirstLandingConsent({
          partyId,
          commandId,
          decisions: [
            { layer: 1, action: "revoke" },
            { layer: 2, action: "revoke" },
          ],
        }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "CONSENT_COMMAND_CONFLICT" &&
        error.status === 409,
    );
  });
});
