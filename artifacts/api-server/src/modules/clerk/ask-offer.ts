import { and, eq } from "drizzle-orm";
import { getDb, engagementsTable, partiesTable } from "@workspace/db";
import { inClerkScope } from "./scope";
import {
  CLIENT_SAFE_DATA_INTENTS,
  DATA_INTENTS,
  type DataIntent,
} from "./data-intents";
import {
  ACTION_INTENTS,
  ACTIONS_FLAG_KEY,
  type ActionIntent,
  type ActionKind,
} from "./actions";
import { isFeatureEnabled } from "../flags/flags";

// Ask Clerk offer assembly (R126, split from ask.ts): the closed catalogues
// and option lists THIS asker is offered — the data intents (firm-scoped
// askers only; client askers the client-safe subset), the act.* keys
// (flag-gated, capability-gated by the route) and the firm's own client
// parties under opaque keys. The model can only ever pick an entry the app
// itself built here; ask.ts re-resolves every pick against these lists.

const CLIENT_OPTION_CAP = 40;

// One client party option: the opaque c1..cN key the model picks, mapped
// back by the app to the party id and its display name.
export interface ClientOption {
  key: string;
  id: string;
  name: string;
}

// Data intents are firm-record lookups, so they are only offered to a
// firm-scoped asker; an operator without a tenant keeps register-only Ask.
// A client_user (SEC-03) gets only the client-safe subset — every lookup
// it can name is pinned to its own party by the step runner — and, fail
// closed, no data intents at all if the principal somehow carries no client
// party.
export function offeredDataIntents(ctx: {
  firmId?: string | null;
  clientScoped: boolean;
  clientPartyId?: string | null;
}): readonly DataIntent[] {
  return !ctx.firmId
    ? []
    : ctx.clientScoped
      ? ctx.clientPartyId
        ? CLIENT_SAFE_DATA_INTENTS
        : []
      : DATA_INTENTS;
}

// Do with Clerk (round 31): act.* keys are offered only when (a) the asker
// already gets data keys (act keys share the data lookups' month/client
// option machinery, and every asker who may approve actions is
// firm-scoped), (b) the actions rollout flag is on (dark = the keys
// simply don't exist, same fail-closed posture as listActionProposals),
// and (c) the route said this principal could approve that kind. A client
// asker keeps its own-party pinning in the step runner, exactly like data
// lookups.
export async function offeredActionIntents(
  ctx: { firmId?: string | null; actionKinds?: ActionKind[] },
  dataIntents: readonly DataIntent[],
): Promise<readonly ActionIntent[]> {
  return ctx.firmId &&
    dataIntents.length > 0 &&
    (ctx.actionKinds?.length ?? 0) > 0 &&
    (await isFeatureEnabled(ACTIONS_FLAG_KEY, ctx.firmId))
    ? ACTION_INTENTS.filter((a) => ctx.actionKinds!.includes(a.kind))
    : [];
}

// Closed parameter options (idea #4), offered only alongside data intents:
// the firm's own client parties under OPAQUE keys the app maps back — the
// model can only ever pick an entry the app itself built. A client asker's
// list is EXACTLY ONE entry: its own party (SEC-03) — the model can only
// ever pick the caller itself. Truncation is computed BEFORE the slice so
// an over-cap list is DETECTED (the prompt's INCOMPLETE line), never silent.
export async function loadClientOptions(
  ctx: {
    firmId?: string | null;
    clientScoped: boolean;
    clientPartyId?: string | null;
  },
  dataIntents: readonly DataIntent[],
): Promise<{ options: ClientOption[]; truncated: boolean }> {
  const clients =
    dataIntents.length > 0 && ctx.firmId
      ? await inClerkScope(ctx.firmId, () =>
          getDb()
            .selectDistinct({
              id: partiesTable.id,
              name: partiesTable.legalName,
            })
            .from(partiesTable)
            .innerJoin(
              engagementsTable,
              eq(engagementsTable.clientPartyId, partiesTable.id),
            )
            .where(
              ctx.clientScoped
                ? and(
                    eq(engagementsTable.firmId, ctx.firmId!),
                    eq(partiesTable.id, ctx.clientPartyId!),
                  )
                : eq(engagementsTable.firmId, ctx.firmId!),
            )
            .orderBy(partiesTable.legalName)
            // One past the cap so truncation is DETECTED, never silent.
            .limit(CLIENT_OPTION_CAP + 1),
        )
      : [];
  const truncated = clients.length > CLIENT_OPTION_CAP;
  const options = clients
    .slice(0, CLIENT_OPTION_CAP)
    .map((c, i) => ({ key: `c${i + 1}`, ...c }));
  return { options, truncated };
}
