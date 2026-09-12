import { and, eq, ne } from "drizzle-orm";
import {
  engagementsTable,
  evidenceRequestsTable,
  filingReturnsTable,
  getDb,
  invoicesTable,
  membershipsTable,
  type EvidenceRequest,
} from "@workspace/db";
import { isUuid } from "../../lib/uuid";
import {
  assertCan,
  assertClientPartyScope,
  requireFirmScope,
  type Capability,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";

export async function evidenceIdentity(
  principal: Principal,
  capability: Capability = "evidence.read",
): Promise<string> {
  assertCan(principal, capability);
  if (
    principal.capabilities ||
    !isUuid(principal.userId) ||
    !["firm_admin", "firm_staff", "client_user"].includes(principal.role)
  ) {
    throw new DomainError(
      "EVIDENCE_ACCOUNT_REQUIRED",
      "Sign in with a client or accounting-team account.",
      403,
    );
  }
  const firmId = requireFirmScope(principal);
  const [membership] = await getDb()
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, firmId),
        eq(membershipsTable.userId, principal.userId),
        eq(membershipsTable.role, principal.role),
        ...(principal.role === "client_user"
          ? [
              eq(
                membershipsTable.clientPartyId,
                principal.clientPartyId ??
                  "00000000-0000-0000-0000-000000000000",
              ),
            ]
          : []),
      ),
    )
    .limit(1);
  if (!membership)
    throw new DomainError(
      "EVIDENCE_ACCOUNT_REQUIRED",
      "Your workspace access has changed. Sign in again.",
      403,
    );
  if (!(await isFeatureEnabled("evidence_hub", firmId)))
    throw new DomainError(
      "NOT_FOUND",
      "Evidence is not available in this workspace.",
      404,
    );
  return firmId;
}

export async function assertEvidenceClient(
  principal: Principal,
  clientPartyId: string,
): Promise<void> {
  assertClientPartyScope(principal, clientPartyId);
  const [engagement] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, requireFirmScope(principal)),
        eq(engagementsTable.clientPartyId, clientPartyId),
        ne(engagementsTable.status, "archived"),
      ),
    )
    .limit(1);
  if (!engagement)
    throw new DomainError(
      "EVIDENCE_CLIENT_UNAVAILABLE",
      "This client is no longer active in your workspace.",
      403,
    );
}

export async function assertEvidenceRequest(
  principal: Principal,
  id: string,
  lock = false,
): Promise<EvidenceRequest> {
  const firmId = await evidenceIdentity(principal);
  const query = getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(
      and(
        eq(evidenceRequestsTable.id, id),
        eq(evidenceRequestsTable.firmId, firmId),
      ),
    )
    .limit(1);
  const [request] = await (lock ? query.for("update") : query);
  if (!request)
    throw new DomainError(
      "EVIDENCE_NOT_FOUND",
      "This evidence request could not be found.",
      404,
    );
  await assertEvidenceClient(principal, request.clientPartyId);
  return request;
}

export async function assertEvidenceOwner(
  firmId: string,
  clientPartyId: string,
  userId: string,
): Promise<void> {
  const memberships = await getDb()
    .select()
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, firmId),
        eq(membershipsTable.userId, userId),
      ),
    );
  if (
    !memberships.some(
      (m) =>
        m.role === "firm_admin" ||
        m.role === "firm_staff" ||
        (m.role === "client_user" && m.clientPartyId === clientPartyId),
    )
  ) {
    throw new DomainError(
      "EVIDENCE_OWNER_INVALID",
      "Choose an owner who can access this client.",
      400,
    );
  }
}

export async function assertEvidenceAnchor(
  firmId: string,
  input: {
    clientPartyId: string;
    invoiceId?: string;
    filingId?: string;
    period?: string;
  },
): Promise<void> {
  if (
    [input.invoiceId, input.filingId, input.period].filter(Boolean).length !== 1
  ) {
    throw new DomainError(
      "EVIDENCE_ANCHOR_REQUIRED",
      "Link this request to one invoice, filing or reporting month.",
      400,
    );
  }
  if (
    input.period &&
    (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period) ||
      input.period.startsWith("0000-"))
  )
    throw new DomainError(
      "EVIDENCE_PERIOD_INVALID",
      "Use a reporting month in YYYY-MM format.",
      400,
    );
  if (input.invoiceId) {
    const [invoice] = await getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, input.invoiceId),
          eq(invoicesTable.firmId, firmId),
          eq(invoicesTable.supplierPartyId, input.clientPartyId),
        ),
      )
      .limit(1);
    if (!invoice)
      throw new DomainError(
        "EVIDENCE_ANCHOR_INVALID",
        "Choose an invoice belonging to this client.",
        400,
      );
  }
  if (input.filingId) {
    const [filing] = await getDb()
      .select({ id: filingReturnsTable.id })
      .from(filingReturnsTable)
      .where(
        and(
          eq(filingReturnsTable.id, input.filingId),
          eq(filingReturnsTable.firmId, firmId),
          eq(filingReturnsTable.clientPartyId, input.clientPartyId),
        ),
      )
      .limit(1);
    if (!filing)
      throw new DomainError(
        "EVIDENCE_ANCHOR_INVALID",
        "Choose a filing belonging to this client.",
        400,
      );
  }
}
