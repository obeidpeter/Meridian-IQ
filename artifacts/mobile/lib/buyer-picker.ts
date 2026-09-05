import {
  PartyType,
  type ListPartiesParams,
  type Party,
} from "@workspace/api-client-react";

export const BUYER_PAGE_SIZE = 20;
export const BUYER_SEARCH_DELAY = 300;

export interface BuyerScope {
  userId: string;
  firmId: string | null;
  clientPartyId: string;
  generation: number;
}

export function buyerScopeKey(scope: BuyerScope): string {
  return JSON.stringify([
    scope.userId,
    scope.firmId,
    scope.clientPartyId,
    scope.generation,
  ]);
}

export function buyerSearchParams(
  search: string,
  offset: number,
): ListPartiesParams {
  const q = search.trim().slice(0, 120);
  return {
    type: PartyType.buyer,
    q: q || undefined,
    limit: BUYER_PAGE_SIZE + 1,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
  };
}

export function buyerSearchKey(scope: BuyerScope, params: ListPartiesParams) {
  return [
    "mobile-invoice-buyers",
    buyerScopeKey(scope),
    "search",
    params,
  ] as const;
}

export function selectedBuyerKey(scope: BuyerScope, id: string | null) {
  return [
    "mobile-invoice-buyers",
    buyerScopeKey(scope),
    "selected",
    id,
  ] as const;
}

function assertCurrent(
  scope: BuyerScope,
  current: () => BuyerScope | null,
  signal?: AbortSignal,
) {
  const now = current();
  if (signal?.aborted || !now || buyerScopeKey(scope) !== buyerScopeKey(now)) {
    const error = new Error("Buyer request belongs to an inactive session.");
    error.name = "AbortError";
    throw error;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isBuyer = (party: Party) =>
  party.type === PartyType.buyer && uuid.test(party.id);

export async function readBuyerPage(
  scope: BuyerScope,
  params: ListPartiesParams,
  fetchPage: (
    params: ListPartiesParams,
    options: { signal?: AbortSignal },
  ) => Promise<Party[]>,
  current: () => BuyerScope | null,
  signal?: AbortSignal,
) {
  assertCurrent(scope, current, signal);
  const rows = await fetchPage(params, { signal });
  assertCurrent(scope, current, signal);
  const seen = new Set<string>();
  const items = rows.slice(0, BUYER_PAGE_SIZE).filter((party) => {
    if (!isBuyer(party) || seen.has(party.id)) return false;
    seen.add(party.id);
    return true;
  });
  return { items, hasNext: rows.length > BUYER_PAGE_SIZE };
}

export async function readAuthorizedBuyer(
  scope: BuyerScope,
  id: string,
  fetchParty: (id: string, options: { signal?: AbortSignal }) => Promise<Party>,
  current: () => BuyerScope | null,
  signal?: AbortSignal,
): Promise<Party> {
  assertCurrent(scope, current, signal);
  if (!uuid.test(id))
    throw new Error("This buyer is unavailable. Choose another buyer.");
  const party = await fetchParty(id, { signal });
  assertCurrent(scope, current, signal);
  if (!isBuyer(party) || party.id.toLowerCase() !== id.toLowerCase()) {
    throw new Error(
      "This party is not an available buyer. Choose another buyer.",
    );
  }
  return party;
}
