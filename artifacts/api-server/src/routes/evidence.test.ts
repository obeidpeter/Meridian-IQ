import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import {
  evidenceFilesTable,
  evidenceRequestsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  getDb,
} from "@workspace/db";
import { requireCsrfHeader } from "../middleware/principal";
import type { Principal } from "../modules/auth/rbac";
import { sweepEvidenceScans } from "../modules/evidence/scanning";
import {
  TEST_EVIDENCE_KEY,
  TEST_EVIDENCE_PDF,
  withMockClamAv,
} from "../modules/evidence/security-test-fixtures";
import { evidenceFixture } from "../modules/evidence/test-fixtures";
import type { evidenceDetail } from "../modules/evidence/views";
import { clientPrincipal, firmPrincipal } from "../test-helpers/principals";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../test-helpers/route-harness";
import evidenceRouter from "./evidence";

type Detail = Awaited<ReturnType<typeof evidenceDetail>>;
type Fixture = Awaited<ReturnType<typeof evidenceFixture>>;
let fixture: Fixture;
let outside: Fixture;
let staffBase: string;
let clientBase: string;
let siblingBase: string;
let foreignBase: string;
let previousKey: string | undefined;
const MARKED_HEADERS = { ...JSON_HEADERS, "x-valo-csrf": "1" };

function routeApp(principal: Principal) {
  // Keep the real CSRF middleware and handlers; only identity resolution is injected.
  const router = Router();
  router.use(requireCsrfHeader);
  router.use(evidenceRouter);
  return appFor(principal, router);
}

before(async () => {
  assert.notEqual(
    process.env.NODE_ENV,
    "production",
    "Evidence route tests cannot run in production",
  );
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "Evidence route tests require the parent's disposable database",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(process.env.DATABASE_URL ?? "").hostname,
    ),
  );
  previousKey = process.env.EVIDENCE_ENCRYPTION_KEY;
  process.env.EVIDENCE_ENCRYPTION_KEY = TEST_EVIDENCE_KEY;
  fixture = await evidenceFixture();
  outside = await evidenceFixture();
  await getDb()
    .insert(featureFlagsTable)
    .values({
      key: "evidence_hub",
      enabled: false,
      releaseTag: "R1",
      description: "Synthetic evidence HTTP tests",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(featureFlagOverridesTable)
    .values([
      { flagKey: "evidence_hub", firmId: fixture.firmId, enabled: true },
      { flagKey: "evidence_hub", firmId: fixture.otherFirmId, enabled: true },
    ]);
  staffBase = await listen(
    routeApp(
      firmPrincipal(fixture.firmId, {
        role: "firm_staff",
        userId: fixture.ownerId,
      }),
    ),
  );
  clientBase = await listen(
    routeApp(
      clientPrincipal(fixture.firmId, fixture.clientPartyId, {
        userId: fixture.clientUserId,
      }),
    ),
  );
  siblingBase = await listen(
    routeApp(
      clientPrincipal(fixture.firmId, fixture.siblingPartyId, {
        userId: fixture.siblingUserId,
      }),
    ),
  );
  foreignBase = await listen(
    routeApp(
      firmPrincipal(fixture.otherFirmId, {
        role: "firm_staff",
        userId: fixture.foreignUserId,
      }),
    ),
  );
});

after(async () => {
  await closeAllServers();
  if (previousKey === undefined) delete process.env.EVIDENCE_ENCRYPTION_KEY;
  else process.env.EVIDENCE_ENCRYPTION_KEY = previousKey;
});

function requestBody(patch: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    clientPartyId: fixture.clientPartyId,
    title: "HTTP supporting record",
    period: "2026-09",
    documentType: "payment_receipt",
    ...patch,
  };
}

function fileBody(version = 1, patch: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    expectedVersion: version,
    filename: "private-http-receipt.pdf",
    contentType: "application/pdf",
    contentBase64: TEST_EVIDENCE_PDF.toString("base64"),
    ...patch,
  };
}

function reviewBody(version = 1, patch: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    expectedVersion: version,
    decision: "needs_changes",
    comment: "Please add a signature",
    ...patch,
  };
}

function metadataBody(version = 1, patch: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    expectedVersion: version,
    dueAt: null,
    ...patch,
  };
}

function send(
  base: string,
  path: string,
  body: unknown,
  method = "POST",
  headers: Record<string, string> = MARKED_HEADERS,
) {
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

async function responseDetail(
  response: Response,
  status: number,
): Promise<Detail> {
  assert.equal(response.status, status, await response.clone().text());
  assertPrivateHeaders(response);
  return (await response.json()) as Detail;
}

async function createRequest(patch: Record<string, unknown> = {}) {
  return responseDetail(
    await send(staffBase, "/evidence/requests", requestBody(patch)),
    201,
  );
}

async function upload() {
  const created = await createRequest();
  const response = await send(
    clientBase,
    `/evidence/requests/${created.request.id}/files`,
    fileBody(created.request.version),
  );
  const uploaded = await responseDetail(response, 201);
  return { created, uploaded, fileId: uploaded.request.latestFileId! };
}

async function scanThroughProtocol(fileId: string, reply: string) {
  await withMockClamAv(
    () => reply,
    async () => {
      for (let pass = 0; pass < 30; pass++) {
        await sweepEvidenceScans();
        const [file] = await getDb()
          .select()
          .from(evidenceFilesTable)
          .where(eq(evidenceFilesTable.id, fileId));
        assert.ok(file);
        if (file.scanStatus !== "quarantined") return;
        assert.equal(
          file.scanError,
          null,
          "The synthetic HTTP scan must not silently fail",
        );
      }
      assert.fail(
        "Target HTTP fixture was not scanned within the bounded queue drain",
      );
    },
  );
}

test("every evidence mutation rejects a missing CSRF marker before changing state", async () => {
  const created = await createRequest();
  const id = created.request.id;
  for (const [method, path, body] of [
    ["POST", "/evidence/requests", requestBody()],
    ["PATCH", `/evidence/requests/${id}`, metadataBody()],
    ["POST", `/evidence/requests/${id}/files`, fileBody()],
    ["POST", `/evidence/requests/${id}/review`, reviewBody()],
    [
      "POST",
      `/evidence/files/${randomUUID()}/scan`,
      { clientRequestId: randomUUID() },
    ],
    ["POST", `/evidence/requests/${id}/assist`, { fileId: randomUUID() }],
  ] as const) {
    const response = await send(staffBase, path, body, method, {
      ...JSON_HEADERS,
      cookie: "valo_session=synthetic-cookie-not-a-credential",
    });
    assert.equal(response.status, 403);
    assert.match(((await response.json()) as { error: string }).error, /CSRF/);
  }
  const unchanged = await responseDetail(
    await fetch(`${staffBase}/evidence/requests/${id}`),
    200,
  );
  assert.equal(unchanged.request.version, 1);
  assert.equal(unchanged.files.length, 0);
  assert.equal(unchanged.events.length, 1);
});

test("malformed request and file UUIDs produce private 400 responses across route families", async () => {
  for (const [method, path, body] of [
    ["GET", "/evidence/requests/not-a-uuid", null],
    ["PATCH", "/evidence/requests/not-a-uuid", metadataBody()],
    ["POST", "/evidence/requests/not-a-uuid/files", fileBody()],
    ["POST", "/evidence/requests/not-a-uuid/review", reviewBody()],
    ["POST", "/evidence/requests/not-a-uuid/assist", { fileId: randomUUID() }],
    ["GET", "/evidence/requests/not-a-uuid/pack", null],
    ["GET", "/evidence/files/not-a-uuid/download", null],
    [
      "POST",
      "/evidence/files/not-a-uuid/scan",
      { clientRequestId: randomUUID() },
    ],
  ] as const) {
    const response =
      method === "GET"
        ? await fetch(`${staffBase}${path}`)
        : await send(staffBase, path, body, method);
    assert.equal(response.status, 400, `${method} ${path}`);
    assertPrivateHeaders(response);
  }
});

test("unknown body fields are rejected rather than changing tenant, scanner or acceptance state", async () => {
  const { uploaded, fileId } = await upload();
  const id = uploaded.request.id;
  for (const [method, path, body] of [
    [
      "POST",
      "/evidence/requests",
      requestBody({ firmId: fixture.otherFirmId }),
    ],
    [
      "PATCH",
      `/evidence/requests/${id}`,
      metadataBody(uploaded.request.version, { status: "accepted" }),
    ],
    [
      "POST",
      `/evidence/requests/${id}/files`,
      fileBody(uploaded.request.version, { scanStatus: "clean" }),
    ],
    [
      "POST",
      `/evidence/requests/${id}/review`,
      reviewBody(uploaded.request.version, { firmId: fixture.otherFirmId }),
    ],
    [
      "POST",
      `/evidence/files/${fileId}/scan`,
      { clientRequestId: randomUUID(), scanStatus: "clean" },
    ],
    [
      "POST",
      `/evidence/requests/${id}/assist`,
      { fileId, decision: "accepted" },
    ],
  ] as const) {
    const response = await send(staffBase, path, body, method);
    assert.equal(response.status, 400, `${method} ${path}`);
    assertPrivateHeaders(response);
  }
  const unchanged = await responseDetail(
    await fetch(`${staffBase}/evidence/requests/${id}`),
    200,
  );
  assert.equal(unchanged.request.version, uploaded.request.version);
  assert.equal(unchanged.request.status, "uploaded");
  assert.equal(unchanged.files[0].scanStatus, "quarantined");
});

test("write routes reject fractional, zero and string versions at the HTTP boundary", async () => {
  const created = await createRequest();
  const id = created.request.id;
  for (const version of [1.5, 0, -1, "1"]) {
    for (const [method, path, body] of [
      [
        "PATCH",
        `/evidence/requests/${id}`,
        metadataBody(1, { expectedVersion: version }),
      ],
      [
        "POST",
        `/evidence/requests/${id}/files`,
        fileBody(1, { expectedVersion: version }),
      ],
      [
        "POST",
        `/evidence/requests/${id}/review`,
        reviewBody(1, { expectedVersion: version }),
      ],
    ] as const)
      assert.equal(
        (await send(staffBase, path, body, method)).status,
        400,
        `${method} ${path} version ${version}`,
      );
  }
  assert.equal(
    (
      await responseDetail(
        await fetch(`${staffBase}/evidence/requests/${id}`),
        200,
      )
    ).request.version,
    1,
  );
});

test("list routes reject fractional pagination, invalid scopes and unknown query fields", async () => {
  for (const query of [
    "offset=0.5",
    "offset=-1",
    "offset=5001",
    "limit=1.5",
    "limit=0",
    "limit=51",
    "offset=not-a-number",
    "clientPartyId=not-a-uuid",
    "firmId=foreign",
    "status=clean",
  ]) {
    const response = await fetch(`${staffBase}/evidence/requests?${query}`);
    assert.equal(response.status, 400, query);
    assertPrivateHeaders(response);
  }
  const valid = await fetch(`${staffBase}/evidence/requests?offset=0&limit=1`);
  assert.equal(valid.status, 200);
  assertPrivateHeaders(valid);
  assert.ok(((await valid.json()) as { items: unknown[] }).items.length <= 1);
});

test("create and metadata routes require real ISO timestamps with an explicit timezone", async () => {
  const created = await createRequest();
  for (const dueAt of [
    0,
    "2026-09-12",
    "12/09/2026",
    "2026-02-30T09:00:00Z",
    "2026-09-12T09:00:00",
    "not-a-date",
  ]) {
    assert.equal(
      (await send(staffBase, "/evidence/requests", requestBody({ dueAt })))
        .status,
      400,
      String(dueAt),
    );
    assert.equal(
      (
        await send(
          staffBase,
          `/evidence/requests/${created.request.id}`,
          metadataBody(1, { dueAt }),
          "PATCH",
        )
      ).status,
      400,
      String(dueAt),
    );
  }
  const withDate = await createRequest({ dueAt: "2026-10-10T10:00:00+01:00" });
  assert.equal(withDate.request.dueAt, "2026-10-10T09:00:00.000Z");
  const updated = await responseDetail(
    await send(
      staffBase,
      `/evidence/requests/${created.request.id}`,
      metadataBody(1, { dueAt: "2026-10-11T10:00:00+01:00" }),
      "PATCH",
    ),
    200,
  );
  assert.equal(updated.request.dueAt, "2026-10-11T09:00:00.000Z");
  const cleared = await responseDetail(
    await send(
      staffBase,
      `/evidence/requests/${created.request.id}`,
      metadataBody(updated.request.version),
      "PATCH",
    ),
    200,
  );
  assert.equal(cleared.request.dueAt, null);
});

test("HTTP creation derives firm and creator from the principal and refuses unengaged clients", async () => {
  const created = await createRequest();
  assert.equal(created.request.firmId, fixture.firmId);
  assert.equal(created.request.createdBy, fixture.ownerId);
  assert.equal(created.request.clientPartyId, fixture.clientPartyId);
  assert.equal(
    (await send(clientBase, "/evidence/requests", requestBody())).status,
    403,
  );
  const foreignClient = await send(
    staffBase,
    "/evidence/requests",
    requestBody({ clientPartyId: outside.clientPartyId }),
  );
  assert.equal(foreignClient.status, 403);
  assert.equal(
    (
      await send(
        staffBase,
        "/evidence/requests",
        requestBody({ createdBy: fixture.foreignUserId }),
      )
    ).status,
    400,
  );
  const [persisted] = await getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(
      and(
        eq(evidenceRequestsTable.id, created.request.id),
        eq(evidenceRequestsTable.firmId, fixture.firmId),
      ),
    );
  assert.ok(persisted);
});

test("client review and reassignment are forbidden even for an accessible clean file", async () => {
  const { uploaded, fileId } = await upload();
  await scanThroughProtocol(fileId, "stream: OK\0");
  for (const base of [clientBase, siblingBase]) {
    const review = await send(
      base,
      `/evidence/requests/${uploaded.request.id}/review`,
      reviewBody(uploaded.request.version, { decision: "accepted", fileId }),
    );
    assert.equal(review.status, 403);
    assertPrivateHeaders(review);
    assert.equal(
      (
        await send(
          base,
          `/evidence/requests/${uploaded.request.id}`,
          metadataBody(uploaded.request.version),
          "PATCH",
        )
      ).status,
      403,
    );
  }
  const unchanged = await responseDetail(
    await fetch(`${staffBase}/evidence/requests/${uploaded.request.id}`),
    200,
  );
  assert.equal(unchanged.request.status, "uploaded");
  assert.equal(unchanged.request.acceptedFileId, null);
});

test("JSON request and list responses are private and contain no encrypted bytes or internal keys", async () => {
  const { uploaded, fileId } = await upload();
  const [file] = await getDb()
    .select()
    .from(evidenceFilesTable)
    .where(eq(evidenceFilesTable.id, fileId));
  assert.ok(file);
  for (const path of [
    `/evidence/requests/${uploaded.request.id}`,
    "/evidence/requests?offset=0&limit=50",
  ]) {
    const response = await fetch(`${clientBase}${path}`);
    assert.equal(response.status, 200);
    assertPrivateHeaders(response);
    const json = await response.text();
    for (const secret of [
      file.encryptedContent,
      file.requestHash,
      TEST_EVIDENCE_PDF.toString("base64"),
      "encryptedContent",
      "clientRequestId",
      "scanToken",
      "leaseUntil",
      "nextScanAt",
    ])
      assert.ok(
        !json.includes(secret),
        "Response must not contain private storage fields",
      );
  }
  for (const base of [siblingBase, foreignBase]) {
    const response = await fetch(
      `${base}/evidence/requests/${uploaded.request.id}`,
    );
    assert.equal(response.status, base === siblingBase ? 403 : 404);
    assertPrivateHeaders(response);
    assert.ok(!(await response.text()).includes(file.encryptedContent));
  }
});

test("quarantined and scanner-rejected documents never produce downloadable bytes", async () => {
  const { fileId } = await upload();
  for (const status of ["quarantined", "rejected"] as const) {
    if (status === "rejected")
      await scanThroughProtocol(
        fileId,
        "stream: SYNTHETIC-NOT-MALWARE FOUND\0",
      );
    const response = await fetch(
      `${clientBase}/evidence/files/${fileId}/download`,
    );
    assert.equal(response.status, 409);
    assertPrivateHeaders(response);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.ok(!(await response.text()).includes(TEST_EVIDENCE_PDF.toString()));
  }
});

test("a clean download is an exact private attachment with sandboxing and no cross-client access", async () => {
  const { fileId } = await upload();
  await scanThroughProtocol(fileId, "stream: OK\0");
  const response = await fetch(
    `${clientBase}/evidence/files/${fileId}/download`,
  );
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.match(response.headers.get("content-type")!, /^application\/pdf/);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="private-http-receipt.pdf"',
  );
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    TEST_EVIDENCE_PDF,
  );
  for (const base of [siblingBase, foreignBase]) {
    const forbidden = await fetch(`${base}/evidence/files/${fileId}/download`);
    assert.equal(forbidden.status, base === siblingBase ? 403 : 404);
    assertPrivateHeaders(forbidden);
    assert.equal(forbidden.headers.get("content-disposition"), null);
  }
});
