import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getGetPartyUrl,
  getListPartiesUrl,
  PartyType,
  type InvoiceDraftResult,
  type Party,
} from "@workspace/api-client-react";
import {
  BUYER_PAGE_SIZE,
  buyerPageView,
  buyerScopeKey,
  buyerSearchKey,
  buyerSearchParams,
  buyerSelectionView,
  readAuthorizedBuyer,
  readBuyerPage,
  selectedBuyerKey,
  type BuyerScope,
  type QueryView,
} from "./buyer-picker";
import { applyDraftProposal } from "./draft-voice";

const scope: BuyerScope = {
  userId: "user-a",
  firmId: "firm-a",
  clientPartyId: "client-a",
  generation: 4,
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function party(n = 1, type: Party["type"] = PartyType.buyer): Party {
  return {
    id: id(n),
    type,
    legalName: `Buyer ${n}`,
    tinValidated: false,
    countryCode: "NG",
    createdAt: "2026-09-04T00:00:00Z",
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

test("buyer searches use bounded generated server q/limit/offset parameters", () => {
  const params = buyerSearchParams("  12345 & Sons  ", 40);
  const url = new URL(getListPartiesUrl(params), "https://test.invalid");
  assert.equal(url.pathname, "/api/parties");
  assert.equal(url.searchParams.get("q"), "12345 & Sons");
  assert.equal(url.searchParams.get("limit"), "21");
  assert.equal(url.searchParams.get("offset"), "40");
  assert.equal(url.searchParams.get("type"), "buyer");
  assert.equal(buyerSearchParams(" ", -1).q, undefined);
  assert.equal(buyerSearchParams("x".repeat(121), Number.NaN).q?.length, 120);
  assert.equal(buyerSearchParams("name", Number.NaN).offset, 0);
});

test("query identities separate actor, firm, supplier, auth generation, search, offset and selected ID", () => {
  const params = buyerSearchParams("Ada", 0);
  const baseline = buyerSearchKey(scope, params);
  for (const change of [
    { userId: "user-b" },
    { firmId: "firm-b" },
    { clientPartyId: "client-b" },
    { generation: 5 },
  ]) {
    const changed = { ...scope, ...change };
    assert.notEqual(buyerScopeKey(scope), buyerScopeKey(changed));
    assert.notDeepEqual(baseline, buyerSearchKey(changed, params));
    assert.notDeepEqual(
      selectedBuyerKey(scope, id(1)),
      selectedBuyerKey(changed, id(1)),
    );
  }
  assert.notDeepEqual(
    baseline,
    buyerSearchKey(scope, buyerSearchParams("Other", 0)),
  );
  assert.notDeepEqual(
    baseline,
    buyerSearchKey(scope, buyerSearchParams("Ada", 20)),
  );
  assert.notDeepEqual(
    selectedBuyerKey(scope, id(1)),
    selectedBuyerKey(scope, id(2)),
  );
});

test("a page renders at most 20 buyers and uses one lookahead row for the next page", async () => {
  const controller = new AbortController();
  const params = buyerSearchParams("Buyer", 20);
  const result = await readBuyerPage(
    scope,
    params,
    async (actual, options) => {
      assert.deepEqual(actual, params);
      assert.equal(options.signal, controller.signal);
      return Array.from({ length: 21 }, (_, index) => party(index + 21));
    },
    () => scope,
    controller.signal,
  );
  assert.equal(result.items.length, BUYER_PAGE_SIZE);
  assert.equal(result.items[0].id, id(21));
  assert.equal(result.items[19].id, id(40));
  assert.equal(result.hasNext, true);
  const last = await readBuyerPage(
    scope,
    params,
    async () => [party(1), party(1), party(2, PartyType.bank)],
    () => scope,
  );
  assert.deepEqual(
    last.items.map((buyer) => buyer.id),
    [id(1)],
  );
  assert.equal(last.hasNext, false);
});

test("selection and voice suggestions hydrate a server-authorized buyer beyond any search page", async () => {
  const suggested = party(900);
  let reads = 0;
  const controller = new AbortController();
  const buyer = await readAuthorizedBuyer(
    scope,
    suggested.id,
    async (requested, options) => {
      reads += 1;
      assert.equal(getGetPartyUrl(requested), `/api/parties/${suggested.id}`);
      assert.equal(options.signal, controller.signal);
      return suggested;
    },
    () => scope,
    controller.signal,
  );
  const proposal: InvoiceDraftResult = {
    proposal: {
      buyerName: suggested.legalName,
      buyerTin: null,
      invoiceNumber: "VOICE-1",
      issueDate: null,
      dueDate: null,
      currency: "NGN",
      lines: [],
    },
    buyerSuggestions: [
      {
        partyId: suggested.id,
        legalName: suggested.legalName,
        tin: null,
        type: PartyType.buyer,
        confidence: 1,
        tinScore: 1,
        nameScore: 1,
      },
    ],
    model: "test",
    promptVersion: "test",
  };
  assert.equal(
    applyDraftProposal(proposal, [buyer.id], "voice").buyerPartyId,
    suggested.id,
  );
  assert.equal(applyDraftProposal(proposal, [], "voice").buyerPartyId, null);
  assert.equal(reads, 1, "no list-page or numeric-list fallback");
});

test("hydration rejects another party type, mismatched ID, numeric ID and server denial", async () => {
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      id(1),
      async () => party(1, PartyType.client_business),
      () => scope,
    ),
    /not an available buyer/,
  );
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      id(1),
      async () => party(2),
      () => scope,
    ),
    /not an available buyer/,
  );
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      "900",
      async () => assert.fail("numeric IDs must never be fetched"),
      () => scope,
    ),
    /unavailable/,
  );
  const denied = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      id(1),
      async () => {
        throw denied;
      },
      () => scope,
    ),
    (error) => error === denied,
  );
});

for (const changed of [
  null,
  { ...scope, generation: 5 },
  { ...scope, clientPartyId: "client-b" },
]) {
  test(`late search and selected-buyer results cannot cross ${changed === null ? "unmount" : changed.generation !== scope.generation ? "auth generation" : "client scope"}`, async () => {
    let current: BuyerScope | null = scope;
    await assert.rejects(
      readAuthorizedBuyer(
        scope,
        id(1),
        async () => {
          current = changed;
          return party();
        },
        () => current,
      ),
      { name: "AbortError" },
    );
    current = scope;
    await assert.rejects(
      readBuyerPage(
        scope,
        buyerSearchParams("", 0),
        async () => {
          current = changed;
          return [party()];
        },
        () => current,
      ),
      { name: "AbortError" },
    );
  });
}

// The derived view the hook spreads into its state, driven through the query
// states react-query can be in. `available` folds enabled + current scope.
const idle = { isError: false, isPending: false, isFetching: false };
const pageOf = (
  items: Party[],
  hasNext: boolean,
  overrides: Partial<QueryView<{ items: Party[]; hasNext: boolean }>> = {},
): QueryView<{ items: Party[]; hasNext: boolean }> => ({
  ...idle,
  fetchStatus: "idle",
  data: { items, hasNext },
  ...overrides,
});

test("buyerPageView: a settled page shows its items and lookahead only while available and not debouncing", () => {
  const page = pageOf([party(1), party(2)], true);
  assert.deepEqual(buyerPageView(true, false, page), {
    items: [party(1), party(2)],
    hasNext: true,
    loading: false,
    paused: false,
    error: false,
  });
  assert.deepEqual(buyerPageView(false, false, page), {
    items: [],
    hasNext: false,
    loading: false,
    paused: false,
    error: false,
  });
  assert.deepEqual(buyerPageView(true, true, page), {
    items: [],
    hasNext: false,
    loading: true,
    paused: false,
    error: false,
  });
});

test("buyerPageView: pending, fetching, paused and error states", () => {
  const empty = pageOf([], false);
  const pending = buyerPageView(true, false, {
    ...empty,
    data: undefined,
    isPending: true,
    fetchStatus: "fetching",
  });
  assert.deepEqual(pending, {
    items: [],
    hasNext: false,
    loading: true,
    paused: false,
    error: false,
  });
  const refetching = buyerPageView(true, false, {
    ...pageOf([party(3)], false),
    isFetching: true,
    fetchStatus: "fetching",
  });
  assert.deepEqual(refetching.items, [party(3)]);
  assert.equal(refetching.loading, true);
  const paused = buyerPageView(true, false, {
    ...empty,
    data: undefined,
    isPending: true,
    fetchStatus: "paused",
  });
  assert.equal(paused.paused, true);
  assert.equal(paused.loading, true);
  const failed = buyerPageView(true, false, {
    ...pageOf([party(4)], true),
    isError: true,
  });
  assert.deepEqual(failed, {
    items: [],
    hasNext: false,
    loading: false,
    paused: false,
    error: true,
  });
  // An error while the search is still debouncing is not yet reportable, and
  // neither is one outside the current scope.
  assert.equal(
    buyerPageView(true, true, { ...empty, isError: true }).error,
    false,
  );
  assert.equal(
    buyerPageView(false, false, { ...empty, isError: true }).error,
    false,
  );
});

test("buyerSelectionView: only a fresh read of the selected ID counts as selected", () => {
  const selection: QueryView<Party> = {
    ...idle,
    fetchStatus: "idle",
    data: party(7),
  };
  assert.deepEqual(buyerSelectionView(true, id(7), selection), {
    selected: party(7),
    selectionLoading: false,
    selectionPaused: false,
    selectionError: false,
  });
  // A stale read (the selection moved on) is not a selection.
  assert.equal(buyerSelectionView(true, id(8), selection).selected, null);
  // Nothing selected: no loading, no error, whatever the query says.
  assert.deepEqual(
    buyerSelectionView(true, null, { ...selection, isError: true }),
    {
      selected: null,
      selectionLoading: false,
      selectionPaused: false,
      selectionError: false,
    },
  );
  // Out of scope: the read is withheld entirely.
  assert.deepEqual(buyerSelectionView(false, id(7), selection), {
    selected: null,
    selectionLoading: false,
    selectionPaused: false,
    selectionError: false,
  });
});

test("buyerSelectionView: pending, refetching, paused and error reads", () => {
  const base: QueryView<Party> = { ...idle, fetchStatus: "idle" };
  assert.deepEqual(
    buyerSelectionView(true, id(7), {
      ...base,
      isPending: true,
      fetchStatus: "fetching",
    }),
    {
      selected: null,
      selectionLoading: true,
      selectionPaused: false,
      selectionError: false,
    },
  );
  const refetching = buyerSelectionView(true, id(7), {
    ...base,
    data: party(7),
    isFetching: true,
    fetchStatus: "fetching",
  });
  assert.equal(refetching.selected, null);
  assert.equal(refetching.selectionLoading, true);
  const paused = buyerSelectionView(true, id(7), {
    ...base,
    data: party(7),
    isPending: true,
    fetchStatus: "paused",
  });
  assert.equal(paused.selected, null);
  assert.equal(paused.selectionPaused, true);
  assert.equal(paused.selectionLoading, true);
  const failed = buyerSelectionView(true, id(7), {
    ...base,
    data: party(7),
    isError: true,
  });
  assert.equal(failed.selected, null);
  assert.equal(failed.selectionError, true);
});

test("cancelled search and hydration cannot publish late responses", async () => {
  const search = new AbortController();
  await assert.rejects(
    readBuyerPage(
      scope,
      buyerSearchParams("", 0),
      async () => {
        search.abort();
        return [party()];
      },
      () => scope,
      search.signal,
    ),
    { name: "AbortError" },
  );
  const hydration = new AbortController();
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      id(1),
      async () => {
        hydration.abort();
        return party();
      },
      () => scope,
      hydration.signal,
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    readAuthorizedBuyer(
      scope,
      id(1),
      async () => assert.fail("aborted request must not start"),
      () => scope,
      hydration.signal,
    ),
    { name: "AbortError" },
  );
});
