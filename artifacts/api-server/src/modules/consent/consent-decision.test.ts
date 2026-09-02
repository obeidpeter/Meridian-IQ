import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, runInBypassContext, partiesTable } from "@workspace/db";
import {
  hasConsentDecision,
  hasLayerConsent,
  recordConsent,
} from "./consent.ts";
import { consentCapturedFor } from "../../routes/identity.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// CORE-03 first-landing capture (D15): "captured" means the business has
// DECIDED on layer 1 — a recorded decline counts, permission does not follow.
const SALT = makeRunSalt();
const undecided = randomUUID();
const declined = randomUUID();
const granted = randomUUID();

before(async () => {
  await runInBypassContext(async () => {
    await getDb()
      .insert(partiesTable)
      .values(
        [undecided, declined, granted].map((id, i) => ({
          id,
          type: "client_business" as const,
          legalName: `Consent decision ${i} ${SALT}`,
          countryCode: "NG",
        })),
      );
    await recordConsent({
      partyId: declined,
      layer: 1,
      action: "revoke",
      scope: "compliance_submission",
      basis: "declined",
      channel: "first_landing",
      actorId: randomUUID(),
    });
    await recordConsent({
      partyId: granted,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "consent",
      channel: "first_landing",
      actorId: randomUUID(),
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
    // Decisions are per layer: layer 2 is still open for all three.
    assert.equal(await hasConsentDecision(granted, 2), false);
  });
});

test("Me.consentCaptured: client users answer for their business, every other role answers null", async () => {
  await runInBypassContext(async () => {
    assert.equal(
      await consentCapturedFor({ role: "client_user", clientPartyId: undecided }),
      false,
    );
    assert.equal(
      await consentCapturedFor({ role: "client_user", clientPartyId: declined }),
      true,
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
      await consentCapturedFor({ role: "client_user", clientPartyId: "dev-scope" }),
      false,
    );
  });
});
