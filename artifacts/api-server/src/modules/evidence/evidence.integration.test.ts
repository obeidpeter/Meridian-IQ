import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  auditEventsTable,
  engagementsTable,
  evidenceEventsTable,
  evidenceFilesTable,
  evidenceRequestsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  filingReturnsTable,
  getDb,
  invoicesTable,
  membershipsTable,
  runRequestContext,
  workItemsTable,
} from "@workspace/db";
import {
  clientPrincipal,
  crossTenantPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { evidenceIdentity } from "./access";
import { readEvidenceFile } from "./files";
import { createEvidenceRequest, type CreateEvidenceInput } from "./requests";
import { retryEvidenceScan } from "./retry-scan";
import { reviewEvidenceRequest, type ReviewEvidenceInput } from "./reviews";
import { sweepEvidenceScans } from "./scanning";
import {
  TEST_EVIDENCE_KEY,
  TEST_EVIDENCE_PDF,
  withEvidenceEnvironment,
  withMockClamAv,
} from "./security-test-fixtures";
import { evidenceFixture } from "./test-fixtures";
import { uploadEvidenceFile, type UploadEvidenceInput } from "./uploads";
import {
  updateEvidenceRequest,
  type UpdateEvidenceInput,
} from "./update-request";
import { evidenceDetail, listEvidenceRequests } from "./views";

type Fixture = Awaited<ReturnType<typeof evidenceFixture>>;
type Detail = Awaited<ReturnType<typeof evidenceDetail>>;
let fixture: Fixture;
let staff: Principal;
let client: Principal;
let sibling: Principal;
let foreign: Principal;
let previousKey: string | undefined;

const scoped = <T>(principal: Principal, run: () => Promise<T>) =>
  runRequestContext({ bypass: false, firmId: principal.firmId }, run);

async function enableFixture(f: Fixture) {
  await getDb()
    .insert(featureFlagsTable)
    .values({
      key: "evidence_hub",
      enabled: false,
      releaseTag: "R1",
      description: "Synthetic evidence integration test",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(featureFlagOverridesTable)
    .values([
      { flagKey: "evidence_hub", firmId: f.firmId, enabled: true },
      { flagKey: "evidence_hub", firmId: f.otherFirmId, enabled: true },
    ]);
}

before(async () => {
  // This suite mutates fixtures and scanner leases. A serving database is never eligible.
  assert.notEqual(
    process.env.NODE_ENV,
    "production",
    "Evidence integration tests cannot run in production",
  );
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "Use the parent's explicitly disposable database, never serving data",
  );
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname),
    "Evidence integration tests require a loopback database",
  );
  previousKey = process.env.EVIDENCE_ENCRYPTION_KEY;
  process.env.EVIDENCE_ENCRYPTION_KEY = TEST_EVIDENCE_KEY;
  fixture = await evidenceFixture();
  await enableFixture(fixture);
  staff = firmPrincipal(fixture.firmId, {
    userId: fixture.ownerId,
    role: "firm_staff",
  });
  client = clientPrincipal(fixture.firmId, fixture.clientPartyId, {
    userId: fixture.clientUserId,
  });
  sibling = clientPrincipal(fixture.firmId, fixture.siblingPartyId, {
    userId: fixture.siblingUserId,
  });
  foreign = firmPrincipal(fixture.otherFirmId, {
    userId: fixture.foreignUserId,
    role: "firm_staff",
  });
});

after(() => {
  if (previousKey === undefined) delete process.env.EVIDENCE_ENCRYPTION_KEY;
  else process.env.EVIDENCE_ENCRYPTION_KEY = previousKey;
});

function requestInput(
  overrides: Partial<CreateEvidenceInput> = {},
): CreateEvidenceInput {
  return {
    clientPartyId: fixture.clientPartyId,
    period: "2026-09",
    title: "Supporting payment record",
    documentType: "payment_receipt",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

function newRequest(overrides: Partial<CreateEvidenceInput> = {}) {
  return scoped(staff, () =>
    createEvidenceRequest(staff, requestInput(overrides)),
  );
}

function uploadInput(
  detail: Detail,
  overrides: Partial<UploadEvidenceInput> = {},
): UploadEvidenceInput {
  return {
    clientRequestId: randomUUID(),
    expectedVersion: detail.request.version,
    filename: "private-receipt.pdf",
    contentType: "application/pdf",
    contentBase64: TEST_EVIDENCE_PDF.toString("base64"),
    ...overrides,
  };
}

async function uploadedRequest() {
  const requested = await newRequest();
  const input = uploadInput(requested);
  const uploaded = await scoped(client, () =>
    uploadEvidenceFile(client, requested.request.id, input),
  );
  return { requested, uploaded, input, fileId: uploaded.request.latestFileId! };
}

function acceptInput(
  detail: Detail,
  overrides: Partial<ReviewEvidenceInput> = {},
): ReviewEvidenceInput {
  return {
    clientRequestId: randomUUID(),
    expectedVersion: detail.request.version,
    decision: "accepted",
    fileId: detail.request.latestFileId!,
    comment: "Compared with the client's supporting record",
    ...overrides,
  };
}

async function fileRow(id: string) {
  const [file] = await getDb()
    .select()
    .from(evidenceFilesTable)
    .where(eq(evidenceFilesTable.id, id));
  assert.ok(file);
  return file;
}

async function scanFile(fileId: string, reply = "stream: OK\0") {
  await withMockClamAv(
    () => reply,
    async () => {
      // Other suites may have queued their own synthetic files in the same scratch DB.
      for (let pass = 0; pass < 30; pass++) {
        await sweepEvidenceScans();
        const file = await fileRow(fileId);
        if (file.scanStatus !== "quarantined" || file.scanError) return;
      }
      assert.fail(
        "The target synthetic file was not processed within 30 bounded scan passes",
      );
    },
  );
}

function domainFailure(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

function databaseFailure(code: string) {
  return (error: unknown) => {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 5 && current && typeof current === "object";
      depth++
    ) {
      if ("code" in current && current.code === code) return true;
      current = "cause" in current ? current.cause : undefined;
    }
    assert.fail(`Expected database guard ${code}`);
  };
}

test("requests and clean downloads stay within the firm and client scope", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  const own = await scoped(client, () => readEvidenceFile(client, fileId));
  assert.deepEqual(own.bytes, TEST_EVIDENCE_PDF);
  const ownList = await scoped(client, () => listEvidenceRequests(client, {}));
  assert.ok(
    ownList.items.some((request) => request.id === uploaded.request.id),
  );
  assert.ok(
    ownList.items.every(
      (request) => request.clientPartyId === fixture.clientPartyId,
    ),
  );
  await assert.rejects(
    scoped(sibling, () => evidenceDetail(sibling, uploaded.request.id)),
    domainFailure("CROSS_CLIENT", 403),
  );
  await assert.rejects(
    scoped(sibling, () => readEvidenceFile(sibling, fileId)),
    domainFailure("CROSS_CLIENT", 403),
  );
  await assert.rejects(
    scoped(sibling, () =>
      listEvidenceRequests(sibling, { clientPartyId: fixture.clientPartyId }),
    ),
    domainFailure("CROSS_CLIENT", 403),
  );
  const siblingList = await scoped(sibling, () =>
    listEvidenceRequests(sibling, {}),
  );
  assert.ok(
    !siblingList.items.some((request) => request.id === uploaded.request.id),
  );
  await assert.rejects(
    scoped(foreign, () => evidenceDetail(foreign, uploaded.request.id)),
    domainFailure("EVIDENCE_NOT_FOUND", 404),
  );
  await assert.rejects(
    scoped(foreign, () => readEvidenceFile(foreign, fileId)),
    domainFailure("EVIDENCE_NOT_FOUND", 404),
  );
  await assert.rejects(
    scoped(foreign, () =>
      reviewEvidenceRequest(
        foreign,
        uploaded.request.id,
        acceptInput(uploaded),
      ),
    ),
    domainFailure("EVIDENCE_NOT_FOUND", 404),
  );
});

test("client users cannot review either their own or a sibling client's uploaded document", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  for (const principal of [client, sibling]) {
    await assert.rejects(
      scoped(principal, () =>
        reviewEvidenceRequest(
          principal,
          uploaded.request.id,
          acceptInput(uploaded),
        ),
      ),
      domainFailure("FORBIDDEN", 403),
    );
    await assert.rejects(
      scoped(principal, () =>
        retryEvidenceScan(principal, fileId, randomUUID()),
      ),
      domainFailure("FORBIDDEN", 403),
    );
    await assert.rejects(
      scoped(principal, () => createEvidenceRequest(principal, requestInput())),
      domainFailure("FORBIDDEN", 403),
    );
  }
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, uploaded.request.id)))
      .request.status,
    "uploaded",
  );
});

test("machine, operator, auditor and bank principals cannot enter the evidence workflow", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  const machine: Principal = {
    ...staff,
    capabilities: [
      "evidence.read",
      "evidence.request",
      "evidence.upload",
      "evidence.review",
    ],
  };
  const forbidden = [
    machine,
    ...(["operator", "auditor", "bank_user"] as const).map((role) => ({
      ...crossTenantPrincipal(role),
      firmId: fixture.firmId,
    })),
  ];
  for (const principal of forbidden) {
    for (const operation of [
      () => evidenceIdentity(principal),
      () => listEvidenceRequests(principal, {}),
      () => createEvidenceRequest(principal, requestInput()),
      () => readEvidenceFile(principal, fileId),
      () =>
        uploadEvidenceFile(
          principal,
          uploaded.request.id,
          uploadInput(uploaded),
        ),
      () =>
        reviewEvidenceRequest(
          principal,
          uploaded.request.id,
          acceptInput(uploaded),
        ),
    ]) {
      await assert.rejects(
        scoped<unknown>(principal, operation),
        (error: unknown) => {
          assert.ok(error instanceof DomainError);
          assert.equal(error.status, 403);
          return true;
        },
      );
    }
  }
});

test("stale or fabricated membership and client scope claims are denied", async () => {
  for (const principal of [
    { ...staff, userId: randomUUID() },
    { ...staff, role: "firm_admin" as const },
    { ...client, clientPartyId: fixture.siblingPartyId },
    { ...client, clientPartyId: null },
    { ...staff, userId: "machine-id" },
  ])
    await assert.rejects(
      scoped(principal, () => evidenceIdentity(principal)),
      domainFailure("EVIDENCE_ACCOUNT_REQUIRED", 403),
    );
  const f = await evidenceFixture();
  await enableFixture(f);
  const member = firmPrincipal(f.firmId, {
    userId: f.ownerId,
    role: "firm_staff",
  });
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, f.firmId),
        eq(membershipsTable.userId, f.ownerId),
      ),
    );
  await assert.rejects(
    scoped(member, () => evidenceIdentity(member)),
    domainFailure("EVIDENCE_ACCOUNT_REQUIRED", 403),
  );
});

test("archiving an engagement immediately denies request, review, upload and download access", async () => {
  const f = await evidenceFixture();
  await enableFixture(f);
  const member = firmPrincipal(f.firmId, {
    userId: f.ownerId,
    role: "firm_staff",
  });
  const owner = clientPrincipal(f.firmId, f.clientPartyId, {
    userId: f.clientUserId,
  });
  const requested = await scoped(member, () =>
    createEvidenceRequest(
      member,
      requestInput({ clientPartyId: f.clientPartyId }),
    ),
  );
  const uploaded = await scoped(owner, () =>
    uploadEvidenceFile(owner, requested.request.id, uploadInput(requested)),
  );
  await scanFile(uploaded.request.latestFileId!);
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, f.firmId),
        eq(engagementsTable.clientPartyId, f.clientPartyId),
      ),
    );
  for (const principal of [member, owner]) {
    await assert.rejects(
      scoped(principal, () => evidenceDetail(principal, requested.request.id)),
      domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
    );
    await assert.rejects(
      scoped(principal, () =>
        readEvidenceFile(principal, uploaded.request.latestFileId!),
      ),
      domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
    );
    await assert.rejects(
      scoped(principal, () =>
        uploadEvidenceFile(
          principal,
          requested.request.id,
          uploadInput(uploaded),
        ),
      ),
      domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
    );
  }
  await assert.rejects(
    scoped(member, () =>
      reviewEvidenceRequest(
        member,
        requested.request.id,
        acceptInput(uploaded),
      ),
    ),
    domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
  );
  await assert.rejects(
    scoped(member, () =>
      createEvidenceRequest(
        member,
        requestInput({ clientPartyId: f.clientPartyId }),
      ),
    ),
    domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
  );
  const listed = await scoped(member, () => listEvidenceRequests(member, {}));
  assert.equal(listed.total, 0);
});

test("the per-firm feature gate also protects already-created documents", async () => {
  const f = await evidenceFixture();
  await enableFixture(f);
  const member = firmPrincipal(f.firmId, {
    userId: f.ownerId,
    role: "firm_staff",
  });
  const requested = await scoped(member, () =>
    createEvidenceRequest(
      member,
      requestInput({ clientPartyId: f.clientPartyId }),
    ),
  );
  await getDb()
    .update(featureFlagOverridesTable)
    .set({ enabled: false })
    .where(
      and(
        eq(featureFlagOverridesTable.flagKey, "evidence_hub"),
        eq(featureFlagOverridesTable.firmId, f.firmId),
      ),
    );
  await assert.rejects(
    scoped(member, () => evidenceDetail(member, requested.request.id)),
    domainFailure("NOT_FOUND", 404),
  );
  await assert.rejects(
    scoped(member, () =>
      createEvidenceRequest(
        member,
        requestInput({ clientPartyId: f.clientPartyId }),
      ),
    ),
    domainFailure("NOT_FOUND", 404),
  );
});

test("invoice and filing anchors must belong to the selected firm and supplier client", async () => {
  const [invoice] = await getDb()
    .insert(invoicesTable)
    .values({
      firmId: fixture.firmId,
      supplierPartyId: fixture.clientPartyId,
      buyerPartyId: fixture.siblingPartyId,
      invoiceNumber: `EVIDENCE-${randomUUID()}`,
      issueDate: "2026-09-12",
    })
    .returning();
  const [filing] = await getDb()
    .insert(filingReturnsTable)
    .values({
      firmId: fixture.firmId,
      clientPartyId: fixture.clientPartyId,
      taxType: "vat",
      period: "2026-09",
      dueDate: "2026-10-21",
    })
    .returning();
  const invoiceRequest = await newRequest({
    invoiceId: invoice.id,
    period: undefined,
  });
  const filingRequest = await newRequest({
    filingId: filing.id,
    period: undefined,
  });
  assert.equal(invoiceRequest.request.invoiceId, invoice.id);
  assert.equal(filingRequest.request.filingId, filing.id);
  for (const anchor of [{ invoiceId: invoice.id }, { filingId: filing.id }]) {
    await assert.rejects(
      newRequest({
        ...anchor,
        clientPartyId: fixture.siblingPartyId,
        period: undefined,
      }),
      domainFailure("EVIDENCE_ANCHOR_INVALID", 400),
    );
    await assert.rejects(
      scoped(foreign, () =>
        createEvidenceRequest(
          foreign,
          requestInput({ ...anchor, period: undefined }),
        ),
      ),
      domainFailure("EVIDENCE_ANCHOR_INVALID", 400),
    );
  }
  for (const bad of [
    { period: undefined },
    { invoiceId: invoice.id },
    { invoiceId: invoice.id, filingId: filing.id, period: undefined },
  ]) {
    await assert.rejects(
      newRequest(bad),
      domainFailure("EVIDENCE_ANCHOR_REQUIRED", 400),
    );
  }
  for (const period of [
    "0000-09",
    "2026-00",
    "2026-13",
    "2026-9",
    "26-09",
    "2026-09-12",
  ]) {
    await assert.rejects(
      newRequest({ period }),
      domainFailure("EVIDENCE_PERIOD_INVALID", 400),
    );
  }
  await assert.rejects(
    newRequest({ invoiceId: randomUUID(), period: undefined }),
    domainFailure("EVIDENCE_ANCHOR_INVALID", 400),
  );
  await assert.rejects(
    newRequest({ filingId: randomUUID(), period: undefined }),
    domainFailure("EVIDENCE_ANCHOR_INVALID", 400),
  );
});

test("request owners must be members able to access that client", async () => {
  for (const ownerId of [
    fixture.siblingUserId,
    fixture.foreignUserId,
    randomUUID(),
  ]) {
    await assert.rejects(
      newRequest({ ownerId }),
      domainFailure("EVIDENCE_OWNER_INVALID", 400),
    );
  }
  assert.equal(
    (await newRequest({ ownerId: fixture.clientUserId })).request.ownerId,
    fixture.clientUserId,
  );
});

test("concurrent create replay produces one request, work item and requested event", async () => {
  const input = requestInput();
  const [first, replay] = await Promise.all([
    scoped(staff, () => createEvidenceRequest(staff, input)),
    scoped(staff, () => createEvidenceRequest(staff, input)),
  ]);
  assert.equal(replay.request.id, first.request.id);
  assert.equal(replay.request.version, 1);
  assert.equal(
    (
      await getDb()
        .select()
        .from(evidenceRequestsTable)
        .where(eq(evidenceRequestsTable.clientRequestId, input.clientRequestId))
    ).length,
    1,
  );
  assert.equal(
    (
      await getDb()
        .select()
        .from(workItemsTable)
        .where(eq(workItemsTable.clientRequestId, first.request.id))
    ).length,
    1,
  );
  assert.equal(
    first.events.filter((event) => event.action === "requested").length,
    1,
  );
  await assert.rejects(
    scoped(staff, () =>
      createEvidenceRequest(staff, { ...input, title: "Different request" }),
    ),
    domainFailure("EVIDENCE_REQUEST_REUSED", 409),
  );
});

test("concurrent upload replay produces one encrypted version and one uploaded event", async () => {
  const detail = await newRequest();
  const input = uploadInput(detail);
  const [first, replay] = await Promise.all([
    scoped(client, () => uploadEvidenceFile(client, detail.request.id, input)),
    scoped(client, () => uploadEvidenceFile(client, detail.request.id, input)),
  ]);
  assert.equal(first.request.latestFileId, replay.request.latestFileId);
  assert.equal(first.request.version, 2);
  assert.equal(replay.files.length, 1);
  assert.equal(
    replay.events.filter((event) => event.action === "uploaded").length,
    1,
  );
  const changedBytes = Buffer.concat([TEST_EVIDENCE_PDF, Buffer.from("\n")]);
  for (const patch of [
    { filename: "different.pdf" },
    { contentBase64: changedBytes.toString("base64") },
    { expectedVersion: 2 },
  ]) {
    await assert.rejects(
      scoped(client, () =>
        uploadEvidenceFile(client, detail.request.id, { ...input, ...patch }),
      ),
      domainFailure("EVIDENCE_REQUEST_REUSED", 409),
    );
  }
});

test("uppercase request UUIDs preserve upload encryption scope and command replays", async () => {
  const createCommand = requestInput();
  const requested = await scoped(staff, () =>
    createEvidenceRequest(staff, createCommand),
  );
  const createReplay = await scoped(staff, () =>
    createEvidenceRequest(staff, {
      ...createCommand,
      clientRequestId: createCommand.clientRequestId.toUpperCase(),
    }),
  );
  assert.equal(createReplay.request.id, requested.request.id);
  assert.equal(
    createReplay.events.filter((event) => event.action === "requested").length,
    1,
  );

  const uppercaseRequestId = requested.request.id.toUpperCase();
  const command = uploadInput(requested);
  const uploaded = await scoped(client, () =>
    uploadEvidenceFile(client, uppercaseRequestId, command),
  );
  const replay = await scoped(client, () =>
    uploadEvidenceFile(client, requested.request.id, {
      ...command,
      clientRequestId: command.clientRequestId.toUpperCase(),
    }),
  );
  assert.equal(replay.request.latestFileId, uploaded.request.latestFileId);
  assert.equal(replay.request.version, uploaded.request.version);
  assert.equal(replay.files.length, 1);
  assert.equal(
    replay.events.filter((event) => event.action === "uploaded").length,
    1,
  );

  const fileId = uploaded.request.latestFileId!;
  await scanFile(fileId);
  assert.equal((await fileRow(fileId)).scanStatus, "clean");
  assert.deepEqual(
    (await scoped(client, () => readEvidenceFile(client, fileId.toUpperCase())))
      .bytes,
    TEST_EVIDENCE_PDF,
  );
  const review = acceptInput(uploaded);
  const accepted = await scoped(staff, () =>
    reviewEvidenceRequest(staff, uppercaseRequestId, review),
  );
  const reviewReplay = await scoped(staff, () =>
    reviewEvidenceRequest(staff, requested.request.id, {
      ...review,
      clientRequestId: review.clientRequestId.toUpperCase(),
    }),
  );
  assert.equal(accepted.request.status, "accepted");
  assert.equal(accepted.request.acceptedFileId, fileId);
  assert.equal(reviewReplay.request.version, accepted.request.version);
  assert.equal(
    reviewReplay.events.filter((event) => event.action === "accepted").length,
    1,
  );
});

test("an uppercase latest file UUID can be accepted and replayed in canonical lowercase", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  const command = acceptInput(uploaded, {
    fileId: fileId.toUpperCase(),
    clientRequestId: randomUUID().toUpperCase(),
  });
  const accepted = await scoped(staff, () =>
    reviewEvidenceRequest(staff, uploaded.request.id, command),
  );
  const replay = await scoped(staff, () =>
    reviewEvidenceRequest(staff, uploaded.request.id, {
      ...command,
      fileId,
      clientRequestId: command.clientRequestId.toLowerCase(),
    }),
  );
  assert.equal(accepted.request.status, "accepted");
  assert.equal(accepted.request.acceptedFileId, fileId);
  assert.equal(accepted.request.latestFileId, fileId);
  assert.equal(replay.request.version, accepted.request.version);
  assert.equal(
    replay.events.filter((event) => event.action === "accepted").length,
    1,
  );
});

test("simultaneous distinct uploads use compare-and-swap and roll back the losing write", async () => {
  const detail = await newRequest();
  const firstInput = uploadInput(detail);
  const secondInput = uploadInput(detail, { filename: "other-receipt.pdf" });
  const results = await Promise.allSettled([
    scoped(client, () =>
      uploadEvidenceFile(client, detail.request.id, firstInput),
    ),
    scoped(client, () =>
      uploadEvidenceFile(client, detail.request.id, secondInput),
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failed = results.find((result) => result.status === "rejected");
  assert.ok(failed?.status === "rejected");
  domainFailure("EVIDENCE_VERSION_CONFLICT", 409)(failed.reason);
  const after = await scoped(client, () =>
    evidenceDetail(client, detail.request.id),
  );
  assert.equal(after.request.version, 2);
  assert.equal(after.files.length, 1);
  assert.equal(
    after.events.filter((event) => event.action === "uploaded").length,
    1,
  );
  const [work] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.clientRequestId, detail.request.id));
  assert.equal(work.status, "in_progress");
});

test("quarantined and rejected files cannot be accepted or downloaded", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  for (const scanStatus of ["quarantined", "rejected"] as const) {
    if (scanStatus === "rejected")
      await scanFile(fileId, "stream: SYNTHETIC-NOT-MALWARE FOUND\0");
    assert.equal((await fileRow(fileId)).scanStatus, scanStatus);
    await assert.rejects(
      scoped(client, () => readEvidenceFile(client, fileId)),
      domainFailure("EVIDENCE_QUARANTINED", 409),
    );
    await assert.rejects(
      scoped(staff, () =>
        reviewEvidenceRequest(
          staff,
          uploaded.request.id,
          acceptInput(uploaded),
        ),
      ),
      domainFailure("EVIDENCE_QUARANTINED", 409),
    );
  }
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, uploaded.request.id)))
      .request.version,
    uploaded.request.version,
  );
});

test("unavailable scanners leave files quarantined and do not claim clean results", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await withEvidenceEnvironment(
    { EVIDENCE_CLAMAV_PORT: undefined },
    async () => {
      assert.equal(await sweepEvidenceScans(), 0);
      const list = await scoped(client, () => listEvidenceRequests(client, {}));
      assert.equal(list.scanAvailable, false);
      assert.match(list.notice!, /quarantined/);
      await assert.rejects(
        scoped(staff, () => retryEvidenceScan(staff, fileId, randomUUID())),
        domainFailure("EVIDENCE_SCAN_UNAVAILABLE", 503),
      );
    },
  );
  assert.equal((await fileRow(fileId)).scanStatus, "quarantined");
  assert.equal(
    (
      await scoped(staff, () => evidenceDetail(staff, uploaded.request.id))
    ).events.filter((event) => event.action === "scan_clean").length,
    0,
  );
});

test("a protocol error remains quarantined with private generic failure details", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(
    fileId,
    "stream: /private/scanner/path INTERNAL-DETAIL ERROR\0",
  );
  const row = await fileRow(fileId);
  assert.equal(row.scanStatus, "quarantined");
  assert.equal(row.scanAttempts, 1);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.scanToken, null);
  assert.ok(row.scanError);
  assert.ok(!row.scanError.includes("INTERNAL-DETAIL"));
  const detail = await scoped(client, () =>
    evidenceDetail(client, uploaded.request.id),
  );
  assert.equal(
    detail.events.filter((event) => event.action === "scan_quarantined").length,
    1,
  );
  assert.ok(!JSON.stringify(detail).includes("/private/scanner/path"));
});

test("retry scan is staff-only, idempotent and queues rather than clearing quarantine", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId, "stream: SYNTHETIC-NOT-MALWARE FOUND\0");
  const key = randomUUID();
  await withMockClamAv(
    () => "stream: OK\0",
    async (scans) => {
      const retry = () =>
        scoped(staff, () => retryEvidenceScan(staff, fileId, key));
      const first = await retry();
      const replay = await retry();
      assert.equal(
        first.files.find((file) => file.id === fileId)!.scanStatus,
        "quarantined",
      );
      assert.equal(
        replay.events.filter((event) => event.action === "scan_requested")
          .length,
        1,
      );
      assert.equal(scans.length, 0);
      await assert.rejects(
        scoped(client, () => readEvidenceFile(client, fileId)),
        domainFailure("EVIDENCE_QUARANTINED", 409),
      );
    },
  );
  await scanFile(fileId);
  assert.equal((await fileRow(fileId)).scanStatus, "clean");
  await assert.rejects(
    scoped(staff, () => retryEvidenceScan(staff, fileId, randomUUID())),
    domainFailure("EVIDENCE_ALREADY_SCANNED", 409),
  );
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, uploaded.request.id)))
      .request.version,
    uploaded.request.version,
  );
});

test("staff can recover an exhausted interrupted scan after its lease expires", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await getDb()
    .update(evidenceFilesTable)
    .set({
      scanStatus: "quarantined",
      scanAttempts: 5,
      scanError: null,
      scanToken: randomUUID(),
      leaseUntil: new Date(Date.now() - 60000),
      nextScanAt: new Date(Date.now() - 60000),
      scannedAt: null,
    })
    .where(eq(evidenceFilesTable.id, fileId));
  const key = randomUUID();
  await withMockClamAv(
    () => "stream: OK\0",
    async (scans) => {
      const retried = await scoped(staff, () =>
        retryEvidenceScan(staff, fileId, key),
      );
      const replay = await scoped(staff, () =>
        retryEvidenceScan(staff, fileId, key),
      );
      assert.equal(retried.request.version, uploaded.request.version);
      assert.equal(
        replay.events.filter((event) => event.action === "scan_requested")
          .length,
        1,
      );
      const queued = await fileRow(fileId);
      assert.equal(queued.scanStatus, "quarantined");
      assert.equal(queued.scanAttempts, 0);
      assert.equal(queued.scanError, null);
      assert.equal(queued.scanToken, null);
      assert.equal(queued.leaseUntil, null);
      assert.equal(queued.scannedAt, null);
      assert.ok(queued.nextScanAt.getTime() <= Date.now());
      assert.equal(scans.length, 0);
      await assert.rejects(
        scoped(client, () => readEvidenceFile(client, fileId)),
        domainFailure("EVIDENCE_QUARANTINED", 409),
      );
    },
  );

  await scanFile(fileId);
  const completed = await fileRow(fileId);
  assert.equal(completed.scanStatus, "clean");
  assert.equal(completed.scanAttempts, 1);
  assert.equal(completed.scanToken, null);
  assert.equal(completed.leaseUntil, null);
  assert.deepEqual(
    (await scoped(client, () => readEvidenceFile(client, fileId))).bytes,
    TEST_EVIDENCE_PDF,
  );
  const detail = await scoped(staff, () =>
    evidenceDetail(staff, uploaded.request.id),
  );
  assert.equal(
    detail.events.filter(
      (event) => event.fileId === fileId && event.action === "scan_clean",
    ).length,
    1,
  );
});

test("an exhausted scan with an unexpired lease cannot be reclaimed by a staff retry", async () => {
  const { fileId } = await uploadedRequest();
  const token = randomUUID();
  const leaseUntil = new Date(Date.now() + 60000);
  await getDb()
    .update(evidenceFilesTable)
    .set({ scanAttempts: 5, scanError: null, scanToken: token, leaseUntil })
    .where(eq(evidenceFilesTable.id, fileId));
  await withMockClamAv(
    () => "stream: OK\0",
    async (scans) => {
      await assert.rejects(
        scoped(staff, () => retryEvidenceScan(staff, fileId, randomUUID())),
        domainFailure("EVIDENCE_SCAN_IN_PROGRESS", 409),
      );
      assert.equal(scans.length, 0);
    },
  );
  const unchanged = await fileRow(fileId);
  assert.equal(unchanged.scanAttempts, 5);
  assert.equal(unchanged.scanToken, token);
  assert.equal(unchanged.leaseUntil?.toISOString(), leaseUntil.toISOString());
});

test("concurrent scans claim each immutable file at most once", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await withMockClamAv(
    () => "stream: OK\0",
    async () => {
      await Promise.all([sweepEvidenceScans(), sweepEvidenceScans()]);
      for (
        let pass = 0;
        pass < 30 && (await fileRow(fileId)).scanStatus !== "clean";
        pass++
      )
        await sweepEvidenceScans();
    },
  );
  const row = await fileRow(fileId);
  assert.equal(row.scanStatus, "clean");
  assert.equal(row.scanAttempts, 1);
  const detail = await scoped(staff, () =>
    evidenceDetail(staff, uploaded.request.id),
  );
  assert.equal(
    detail.events.filter(
      (event) => event.fileId === fileId && event.action === "scan_clean",
    ).length,
    1,
  );
});

test("human acceptance is idempotent and pins the clean latest version without changing the invoice", async () => {
  const [invoice] = await getDb()
    .insert(invoicesTable)
    .values({
      firmId: fixture.firmId,
      supplierPartyId: fixture.clientPartyId,
      buyerPartyId: fixture.siblingPartyId,
      invoiceNumber: `ACCEPT-${randomUUID()}`,
      issueDate: "2026-09-12",
    })
    .returning();
  const request = await newRequest({
    invoiceId: invoice.id,
    period: undefined,
  });
  const uploaded = await scoped(client, () =>
    uploadEvidenceFile(client, request.request.id, uploadInput(request)),
  );
  await scanFile(uploaded.request.latestFileId!);
  const input = acceptInput(uploaded);
  const [first, replay] = await Promise.all([
    scoped(staff, () =>
      reviewEvidenceRequest(staff, uploaded.request.id, input),
    ),
    scoped(staff, () =>
      reviewEvidenceRequest(staff, uploaded.request.id, input),
    ),
  ]);
  assert.equal(first.request.status, "accepted");
  assert.equal(first.request.acceptedFileId, uploaded.request.latestFileId);
  assert.equal(first.request.version, uploaded.request.version + 1);
  assert.equal(replay.request.version, first.request.version);
  assert.equal(
    replay.events.filter((event) => event.action === "accepted").length,
    1,
  );
  assert.deepEqual(
    (
      await scoped(client, () =>
        readEvidenceFile(client, first.request.acceptedFileId!),
      )
    ).bytes,
    TEST_EVIDENCE_PDF,
  );
  for (const patch of [
    { comment: "Different review" },
    { decision: "needs_changes" as const, comment: "Correction" },
  ]) {
    await assert.rejects(
      scoped(staff, () =>
        reviewEvidenceRequest(staff, uploaded.request.id, {
          ...input,
          ...patch,
        }),
      ),
      domainFailure("EVIDENCE_REQUEST_REUSED", 409),
    );
  }
  const [unchanged] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoice.id));
  assert.equal(unchanged.status, "draft");
  assert.equal(unchanged.contentRevision, invoice.contentRevision);
  const [work] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.clientRequestId, request.request.id));
  assert.equal(work.status, "done");
});

test("stale review and a file from another request cannot accept the wrong version", async () => {
  const first = await uploadedRequest();
  const second = await uploadedRequest();
  await scanFile(first.fileId);
  await scanFile(second.fileId);
  await assert.rejects(
    scoped(staff, () =>
      reviewEvidenceRequest(
        staff,
        first.uploaded.request.id,
        acceptInput(first.uploaded, { fileId: second.fileId }),
      ),
    ),
    domainFailure("EVIDENCE_FILE_CHANGED", 409),
  );
  const newer = await scoped(client, () =>
    uploadEvidenceFile(
      client,
      first.uploaded.request.id,
      uploadInput(first.uploaded, { filename: "replacement.pdf" }),
    ),
  );
  await assert.rejects(
    scoped(staff, () =>
      reviewEvidenceRequest(
        staff,
        first.uploaded.request.id,
        acceptInput(first.uploaded),
      ),
    ),
    domainFailure("EVIDENCE_VERSION_CONFLICT", 409),
  );
  await assert.rejects(
    scoped(staff, () =>
      reviewEvidenceRequest(
        staff,
        newer.request.id,
        acceptInput(newer, { fileId: first.fileId }),
      ),
    ),
    domainFailure("EVIDENCE_FILE_CHANGED", 409),
  );
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, newer.request.id))).request
      .acceptedFileId,
    null,
  );
});

test("a simultaneous replacement and acceptance cannot both win the same version", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  const outcomes = await Promise.allSettled([
    scoped(client, () =>
      uploadEvidenceFile(
        client,
        uploaded.request.id,
        uploadInput(uploaded, { filename: "new-version.pdf" }),
      ),
    ),
    scoped(staff, () =>
      reviewEvidenceRequest(staff, uploaded.request.id, acceptInput(uploaded)),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(failed?.status === "rejected");
  domainFailure("EVIDENCE_VERSION_CONFLICT", 409)(failed.reason);
  const after = await scoped(staff, () =>
    evidenceDetail(staff, uploaded.request.id),
  );
  assert.equal(after.request.version, uploaded.request.version + 1);
  if (after.request.status === "accepted") {
    assert.equal(after.request.acceptedFileId, fileId);
    assert.equal(after.files.length, 1);
  } else {
    assert.equal(after.request.status, "uploaded");
    assert.equal(after.request.acceptedFileId, null);
    assert.equal(after.files.length, 2);
  }
});

test("closed requests reject uploads; reopening retains earlier versions and review history", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  const accepted = await scoped(staff, () =>
    reviewEvidenceRequest(staff, uploaded.request.id, acceptInput(uploaded)),
  );
  await assert.rejects(
    scoped(client, () =>
      uploadEvidenceFile(client, accepted.request.id, uploadInput(accepted)),
    ),
    domainFailure("EVIDENCE_CLOSED", 409),
  );
  await assert.rejects(
    scoped(staff, () =>
      reviewEvidenceRequest(
        staff,
        accepted.request.id,
        acceptInput(accepted, { decision: "needs_changes", comment: " " }),
      ),
    ),
    domainFailure("EVIDENCE_COMMENT_REQUIRED", 400),
  );
  const reopened = await scoped(staff, () =>
    reviewEvidenceRequest(
      staff,
      accepted.request.id,
      acceptInput(accepted, {
        decision: "needs_changes",
        comment: "Include the missing signature",
      }),
    ),
  );
  assert.equal(reopened.request.acceptedFileId, null);
  const replacement = await scoped(client, () =>
    uploadEvidenceFile(client, reopened.request.id, uploadInput(reopened)),
  );
  assert.equal(replacement.files.length, 2);
  assert.ok(replacement.files.some((file) => file.id === fileId));
  assert.equal(
    replacement.events.filter((event) => event.action === "accepted").length,
    1,
  );
  const cancelled = await scoped(staff, () =>
    reviewEvidenceRequest(
      staff,
      replacement.request.id,
      acceptInput(replacement, {
        decision: "cancelled",
        comment: "Request no longer needed",
      }),
    ),
  );
  await assert.rejects(
    scoped(client, () =>
      uploadEvidenceFile(client, cancelled.request.id, uploadInput(cancelled)),
    ),
    domainFailure("EVIDENCE_CLOSED", 409),
  );
  await assert.rejects(
    scoped(staff, () =>
      reviewEvidenceRequest(
        staff,
        cancelled.request.id,
        acceptInput(cancelled, {
          decision: "needs_changes",
          comment: "Reopen cancelled request",
        }),
      ),
    ),
    domainFailure("EVIDENCE_CLOSED", 409),
  );
});

test("a failed outer transaction rolls back evidence, events and linked work together", async () => {
  const input = requestInput();
  let id = "";
  await assert.rejects(
    scoped(staff, async () => {
      const created = await createEvidenceRequest(staff, input);
      id = created.request.id;
      await uploadEvidenceFile(staff, id, uploadInput(created));
      throw new Error("Synthetic caller rollback");
    }),
    /Synthetic caller rollback/,
  );
  assert.ok(id);
  for (const rows of [
    await getDb()
      .select()
      .from(evidenceRequestsTable)
      .where(eq(evidenceRequestsTable.id, id)),
    await getDb()
      .select()
      .from(evidenceFilesTable)
      .where(eq(evidenceFilesTable.requestId, id)),
    await getDb()
      .select()
      .from(evidenceEventsTable)
      .where(eq(evidenceEventsTable.requestId, id)),
    await getDb()
      .select()
      .from(workItemsTable)
      .where(eq(workItemsTable.clientRequestId, id)),
  ])
    assert.equal(rows.length, 0);
});

test("response views omit encrypted content, request hashes and scanner lease internals", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  const persisted = await fileRow(fileId);
  assert.notEqual(persisted.encryptedContent, TEST_EVIDENCE_PDF.toString());
  assert.ok(
    !persisted.encryptedContent.includes(TEST_EVIDENCE_PDF.toString("base64")),
  );
  const view = await scoped(client, () =>
    evidenceDetail(client, uploaded.request.id),
  );
  const json = JSON.stringify(view);
  for (const privateValue of [
    persisted.encryptedContent,
    TEST_EVIDENCE_PDF.toString("base64"),
    "encryptedContent",
    "requestHash",
    "clientRequestId",
    "scanToken",
    "leaseUntil",
    "scanAttempts",
    "nextScanAt",
  ]) {
    assert.ok(
      !json.includes(privateValue),
      `Private storage field escaped the response view: ${privateValue.length < 30 ? privateValue : "document bytes"}`,
    );
  }
  const audits = await getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.entityId, uploaded.request.id));
  assert.ok(audits.length >= 2);
  const auditJson = JSON.stringify(audits);
  for (const privateValue of [
    persisted.encryptedContent,
    TEST_EVIDENCE_PDF.toString("base64"),
    persisted.filename,
    uploaded.request.title,
  ])
    assert.ok(!auditJson.includes(privateValue));
});

test("database guards preserve append-only evidence versions, events and request anchors", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  const event = uploaded.events.find((row) => row.action === "uploaded")!;
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .update(evidenceEventsTable)
        .set({ comment: "Rewrite history" })
        .where(eq(evidenceEventsTable.id, event.id)),
    ),
    databaseFailure("42501"),
  );
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .delete(evidenceEventsTable)
        .where(eq(evidenceEventsTable.id, event.id)),
    ),
    databaseFailure("42501"),
  );
  for (const patch of [
    { filename: "rewritten.pdf" },
    { encryptedContent: "tampered-content" },
    { sha256: "a".repeat(64) },
    { uploadedBy: fixture.ownerId },
  ]) {
    await assert.rejects(
      scoped(staff, () =>
        getDb()
          .update(evidenceFilesTable)
          .set(patch)
          .where(eq(evidenceFilesTable.id, fileId)),
      ),
      databaseFailure("23514"),
    );
  }
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .delete(evidenceFilesTable)
        .where(eq(evidenceFilesTable.id, fileId)),
    ),
    databaseFailure("42501"),
  );
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .update(evidenceRequestsTable)
        .set({ clientPartyId: fixture.siblingPartyId })
        .where(eq(evidenceRequestsTable.id, uploaded.request.id)),
    ),
    databaseFailure("23514"),
  );
  assert.equal((await fileRow(fileId)).filename, "private-receipt.pdf");
});

test("database guards reject wrong-request pointers and unclean acceptance even outside services", async () => {
  const first = await uploadedRequest();
  const second = await uploadedRequest();
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .update(evidenceRequestsTable)
        .set({ latestFileId: second.fileId })
        .where(eq(evidenceRequestsTable.id, first.uploaded.request.id)),
    ),
    databaseFailure("23503"),
  );
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .update(evidenceRequestsTable)
        .set({ status: "accepted", acceptedFileId: first.fileId })
        .where(eq(evidenceRequestsTable.id, first.uploaded.request.id)),
    ),
    databaseFailure("23514"),
  );
  await assert.rejects(
    scoped(staff, () =>
      getDb().insert(evidenceEventsTable).values({
        firmId: fixture.firmId,
        requestId: first.uploaded.request.id,
        actorId: fixture.ownerId,
        action: "synthetic_cross_request",
        fileId: second.fileId,
      }),
    ),
    databaseFailure("23503"),
  );
  await scanFile(first.fileId);
  await scoped(staff, () =>
    reviewEvidenceRequest(
      staff,
      first.uploaded.request.id,
      acceptInput(first.uploaded),
    ),
  );
  await assert.rejects(
    scoped(staff, () =>
      getDb()
        .update(evidenceFilesTable)
        .set({ scanStatus: "quarantined" })
        .where(eq(evidenceFilesTable.id, first.fileId)),
    ),
    databaseFailure("23514"),
  );
});

test("assignment updates are staff-only and deny foreign, machine and cross-tenant roles", async () => {
  const detail = await newRequest();
  const input: UpdateEvidenceInput = {
    clientRequestId: randomUUID(),
    expectedVersion: detail.request.version,
    dueAt: "2026-10-15T09:00:00.000Z",
  };
  const principals: Principal[] = [
    client,
    sibling,
    { ...staff, capabilities: ["evidence.read", "evidence.request"] },
    ...(["operator", "auditor", "bank_user"] as const).map((role) => ({
      ...crossTenantPrincipal(role),
      firmId: fixture.firmId,
    })),
  ];
  for (const principal of principals) {
    await assert.rejects(
      scoped(principal, () =>
        updateEvidenceRequest(principal, detail.request.id, input),
      ),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.status, 403);
        return true;
      },
    );
  }
  await assert.rejects(
    scoped(foreign, () =>
      updateEvidenceRequest(foreign, detail.request.id, input),
    ),
    domainFailure("EVIDENCE_NOT_FOUND", 404),
  );
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, detail.request.id)))
      .request.version,
    detail.request.version,
  );
});

test("owner and deadline replay changes one version, event and work projection", async () => {
  const detail = await newRequest();
  await getDb()
    .update(evidenceRequestsTable)
    .set({ lastReminderAt: new Date() })
    .where(eq(evidenceRequestsTable.id, detail.request.id));
  const input: UpdateEvidenceInput = {
    clientRequestId: randomUUID(),
    expectedVersion: detail.request.version,
    ownerId: fixture.clientUserId,
    dueAt: "2026-10-15T09:00:00.000Z",
  };
  const [first, replay] = await Promise.all([
    scoped(staff, () => updateEvidenceRequest(staff, detail.request.id, input)),
    scoped(staff, () => updateEvidenceRequest(staff, detail.request.id, input)),
  ]);
  assert.equal(first.request.ownerId, fixture.clientUserId);
  assert.equal(first.request.dueAt, input.dueAt);
  assert.equal(first.request.status, "requested");
  assert.equal(first.request.version, detail.request.version + 1);
  assert.equal(replay.request.version, first.request.version);
  assert.equal(
    replay.events.filter((event) => event.action === "assignment_updated")
      .length,
    1,
  );
  const [persisted] = await getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(eq(evidenceRequestsTable.id, detail.request.id));
  assert.equal(persisted.lastReminderAt, null);
  const [work] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.clientRequestId, detail.request.id));
  assert.equal(work.assignedTo, fixture.clientUserId);
  assert.equal(work.dueAt?.toISOString(), input.dueAt);
  for (const patch of [
    { ownerId: fixture.ownerId },
    { dueAt: null },
    { expectedVersion: first.request.version },
  ]) {
    await assert.rejects(
      scoped(staff, () =>
        updateEvidenceRequest(staff, detail.request.id, { ...input, ...patch }),
      ),
      domainFailure("EVIDENCE_REQUEST_REUSED", 409),
    );
  }
});

test("owner-only updates preserve deadlines and an explicit null clears the deadline", async () => {
  const deadline = "2026-10-20T09:00:00.000Z";
  const requested = await newRequest({ dueAt: deadline });
  const reassigned = await scoped(staff, () =>
    updateEvidenceRequest(staff, requested.request.id, {
      clientRequestId: randomUUID(),
      expectedVersion: requested.request.version,
      ownerId: fixture.clientUserId,
    }),
  );
  assert.equal(reassigned.request.dueAt, deadline);
  const cleared = await scoped(staff, () =>
    updateEvidenceRequest(staff, requested.request.id, {
      clientRequestId: randomUUID(),
      expectedVersion: reassigned.request.version,
      dueAt: null,
    }),
  );
  assert.equal(cleared.request.dueAt, null);
  assert.equal(cleared.request.ownerId, fixture.clientUserId);
  const [work] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.clientRequestId, requested.request.id));
  assert.equal(work.dueAt, null);
  assert.equal(work.assignedTo, fixture.clientUserId);
});

test("assignment validates owners and requires a change without consuming the version on failure", async () => {
  const detail = await newRequest();
  for (const ownerId of [
    fixture.siblingUserId,
    fixture.foreignUserId,
    randomUUID(),
  ]) {
    await assert.rejects(
      scoped(staff, () =>
        updateEvidenceRequest(staff, detail.request.id, {
          clientRequestId: randomUUID(),
          expectedVersion: detail.request.version,
          ownerId,
        }),
      ),
      domainFailure("EVIDENCE_OWNER_INVALID", 400),
    );
  }
  await assert.rejects(
    scoped(staff, () =>
      updateEvidenceRequest(staff, detail.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: detail.request.version,
      }),
    ),
    domainFailure("EVIDENCE_CHANGE_REQUIRED", 400),
  );
  const after = await scoped(staff, () =>
    evidenceDetail(staff, detail.request.id),
  );
  assert.equal(after.request.version, detail.request.version);
  assert.equal(
    after.events.filter((event) => event.action === "assignment_updated")
      .length,
    0,
  );
});

test("simultaneous owner and deadline edits reject stale writes rather than lose an update", async () => {
  const detail = await newRequest();
  const outcomes = await Promise.allSettled([
    scoped(staff, () =>
      updateEvidenceRequest(staff, detail.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: detail.request.version,
        ownerId: fixture.clientUserId,
      }),
    ),
    scoped(staff, () =>
      updateEvidenceRequest(staff, detail.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: detail.request.version,
        dueAt: "2026-10-25T09:00:00.000Z",
      }),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(failure?.status === "rejected");
  domainFailure("EVIDENCE_VERSION_CONFLICT", 409)(failure.reason);
  const after = await scoped(staff, () =>
    evidenceDetail(staff, detail.request.id),
  );
  assert.equal(after.request.version, detail.request.version + 1);
  assert.equal(
    after.events.filter((event) => event.action === "assignment_updated")
      .length,
    1,
  );
  const [work] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.clientRequestId, detail.request.id));
  assert.equal(work.assignedTo, after.request.ownerId);
  assert.equal(work.dueAt?.toISOString() ?? null, after.request.dueAt);
});

test("assignment changes and uploads share the same request CAS boundary", async () => {
  const detail = await newRequest();
  const outcomes = await Promise.allSettled([
    scoped(staff, () =>
      updateEvidenceRequest(staff, detail.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: detail.request.version,
        ownerId: fixture.clientUserId,
      }),
    ),
    scoped(client, () =>
      uploadEvidenceFile(client, detail.request.id, uploadInput(detail)),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(failure?.status === "rejected");
  domainFailure("EVIDENCE_VERSION_CONFLICT", 409)(failure.reason);
  const after = await scoped(staff, () =>
    evidenceDetail(staff, detail.request.id),
  );
  assert.equal(after.request.version, detail.request.version + 1);
  assert.equal(
    after.events.filter((event) =>
      ["assignment_updated", "uploaded"].includes(event.action),
    ).length,
    1,
  );
});

test("closed and archived requests cannot have their assignment changed", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scanFile(fileId);
  const accepted = await scoped(staff, () =>
    reviewEvidenceRequest(staff, uploaded.request.id, acceptInput(uploaded)),
  );
  await assert.rejects(
    scoped(staff, () =>
      updateEvidenceRequest(staff, accepted.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: accepted.request.version,
        dueAt: null,
      }),
    ),
    domainFailure("EVIDENCE_CLOSED", 409),
  );
  const request = await newRequest();
  const cancelled = await scoped(staff, () =>
    reviewEvidenceRequest(staff, request.request.id, {
      clientRequestId: randomUUID(),
      expectedVersion: request.request.version,
      decision: "cancelled",
      comment: "No longer required",
    }),
  );
  await assert.rejects(
    scoped(staff, () =>
      updateEvidenceRequest(staff, cancelled.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: cancelled.request.version,
        dueAt: null,
      }),
    ),
    domainFailure("EVIDENCE_CLOSED", 409),
  );
  const f = await evidenceFixture();
  await enableFixture(f);
  const member = firmPrincipal(f.firmId, {
    userId: f.ownerId,
    role: "firm_staff",
  });
  const active = await scoped(member, () =>
    createEvidenceRequest(
      member,
      requestInput({ clientPartyId: f.clientPartyId }),
    ),
  );
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, f.firmId),
        eq(engagementsTable.clientPartyId, f.clientPartyId),
      ),
    );
  await assert.rejects(
    scoped(member, () =>
      updateEvidenceRequest(member, active.request.id, {
        clientRequestId: randomUUID(),
        expectedVersion: active.request.version,
        dueAt: null,
      }),
    ),
    domainFailure("EVIDENCE_CLIENT_UNAVAILABLE", 403),
  );
});

test("command keys cannot be reused across request creation, assignment and upload", async () => {
  const input = requestInput();
  const detail = await scoped(staff, () => createEvidenceRequest(staff, input));
  const metadata: UpdateEvidenceInput = {
    clientRequestId: input.clientRequestId,
    expectedVersion: detail.request.version,
    dueAt: null,
  };
  await assert.rejects(
    scoped(staff, () =>
      updateEvidenceRequest(staff, detail.request.id, metadata),
    ),
    domainFailure("EVIDENCE_REQUEST_REUSED", 409),
  );
  await assert.rejects(
    scoped(client, () =>
      uploadEvidenceFile(
        client,
        detail.request.id,
        uploadInput(detail, { clientRequestId: input.clientRequestId }),
      ),
    ),
    domainFailure("EVIDENCE_REQUEST_REUSED", 409),
  );
  const updateKey = randomUUID();
  const updated = await scoped(staff, () =>
    updateEvidenceRequest(staff, detail.request.id, {
      ...metadata,
      clientRequestId: updateKey,
    }),
  );
  await assert.rejects(
    scoped(client, () =>
      uploadEvidenceFile(
        client,
        detail.request.id,
        uploadInput(updated, { clientRequestId: updateKey }),
      ),
    ),
    domainFailure("EVIDENCE_REQUEST_REUSED", 409),
  );
  assert.equal(
    (await scoped(staff, () => evidenceDetail(staff, detail.request.id))).files
      .length,
    0,
  );
});

test("RLS hides all three evidence tables from another firm and denies forged inserts", async () => {
  const { uploaded, fileId } = await uploadedRequest();
  await scoped(foreign, async () => {
    assert.equal(
      (
        await getDb()
          .select()
          .from(evidenceRequestsTable)
          .where(eq(evidenceRequestsTable.id, uploaded.request.id))
      ).length,
      0,
    );
    assert.equal(
      (
        await getDb()
          .select()
          .from(evidenceFilesTable)
          .where(eq(evidenceFilesTable.id, fileId))
      ).length,
      0,
    );
    assert.equal(
      (
        await getDb()
          .select()
          .from(evidenceEventsTable)
          .where(eq(evidenceEventsTable.requestId, uploaded.request.id))
      ).length,
      0,
    );
  });
  await assert.rejects(
    scoped(foreign, () =>
      getDb().insert(evidenceEventsTable).values({
        firmId: fixture.firmId,
        requestId: uploaded.request.id,
        actorId: fixture.foreignUserId,
        action: "synthetic_forged_event",
      }),
    ),
    databaseFailure("42501"),
  );
  await assert.rejects(
    scoped(foreign, () =>
      getDb().insert(evidenceEventsTable).values({
        firmId: fixture.otherFirmId,
        requestId: uploaded.request.id,
        actorId: fixture.foreignUserId,
        action: "synthetic_cross_firm_event",
      }),
    ),
    databaseFailure("23503"),
  );
});
