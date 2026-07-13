import { eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  usersTable,
  firmsTable,
  partiesTable,
  engagementsTable,
} from "@workspace/db";
import {
  CLERK_FLAG_KEY,
  createGateway,
  type ClerkGateway,
  type ClerkProvider,
} from "./gateway.ts";
import { setFlag } from "../flags/flags.ts";

// Shared support for the clerk test files: save/force-on the kill switch in
// before(), restore it in after(); module state is per-file because node:test
// runs one process per file.

let flagWasEnabled: boolean | null = null;

// Remember + force the kill switch ON so tests exercise real code paths.
export async function saveAndEnableClerkFlag(): Promise<void> {
  const db = getDb();
  const [flag] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY))
    .limit(1);
  flagWasEnabled = flag ? flag.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: CLERK_FLAG_KEY, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
}

// Restore the pre-run state: delete the flag if it did not exist before,
// otherwise set it back to the saved value.
export async function restoreClerkFlag(): Promise<void> {
  if (flagWasEnabled === null) {
    await getDb()
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY));
  } else {
    await setFlag(CLERK_FLAG_KEY, flagWasEnabled);
  }
}

// Fixed firm/supplier/buyer/engagement fixtures shared by the clerk test
// files. The IDs are fixed at the call sites: append-only ledgers (clerk
// cases, inference calls, invoice lifecycle events) keep referenced rows
// forever, so reruns must not accumulate fixtures.
export async function ensureClerkFixtures(input: {
  users: Array<{ id: string; email: string }>;
  firmId: string;
  firmName: string;
  supplierId: string;
  supplierName: string;
  buyerId: string;
  buyerName: string;
  engagementTitle: string;
}): Promise<void> {
  const db = getDb();
  await db.insert(usersTable).values(input.users).onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: input.firmId, name: input.firmName })
    .onConflictDoNothing();
  await db
    .insert(partiesTable)
    .values([
      {
        id: input.supplierId,
        type: "client_business",
        legalName: input.supplierName,
      },
      { id: input.buyerId, type: "buyer", legalName: input.buyerName },
    ])
    .onConflictDoNothing();
  // Party-in-firm linkage runs through engagements.
  const existing = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.firmId, input.firmId));
  if (existing.length === 0) {
    await db.insert(engagementsTable).values([
      {
        firmId: input.firmId,
        clientPartyId: input.supplierId,
        type: "readiness_assessment",
        title: input.engagementTitle,
      },
      {
        firmId: input.firmId,
        clientPartyId: input.buyerId,
        type: "readiness_assessment",
        title: input.engagementTitle,
      },
    ]);
  }
}

// What the injected fake provider may return: a bare string, or content plus
// token usage (the cost-tracking tests exercise the latter).
export type FakeResponse =
  | string
  | {
      content: string;
      promptTokens?: number | null;
      completionTokens?: number | null;
    };

// A ClerkProvider stub wrapped in the real gateway: the fail-closed pipeline
// (kill switch, ledger, schema validation) runs for real; only the model call
// is faked. The stub ignores the completion request.
export function fakeGateway(
  respond: () => FakeResponse | Promise<FakeResponse>,
  model = "fake-model-test",
): ClerkGateway {
  const provider: ClerkProvider = {
    model,
    complete: async () => respond(),
  };
  return createGateway(provider);
}
