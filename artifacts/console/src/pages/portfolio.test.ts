import { test, expect, describe } from "vitest";
import {
  PORTFOLIO_GROUPS,
  calendarHasContent,
  rejectionsHaveContent,
  visiblePortfolioGroups,
  GETTING_STARTED_DISMISS_KEY,
  gettingStartedSteps,
  completedStepCount,
  shouldShowGettingStarted,
  hasClientOwnerInvite,
  portfolioInvoiceCount,
  portfolioSubmittedCount,
  readGettingStartedDismissed,
  writeGettingStartedDismissed,
} from "./portfolio";

// The portfolio's card groups are layout only — every card keeps its own
// gating and testids — but the grouping itself is contract: ids feed both
// the anchor row's hrefs and the section testids, so they must stay unique
// and anchor-safe.
describe("PORTFOLIO_GROUPS", () => {
  test("the four groups render in scanning order", () => {
    expect(PORTFOLIO_GROUPS.map((g) => g.id)).toEqual([
      "clients",
      "money",
      "compliance",
      "connections",
    ]);
  });

  test("ids are unique, anchor-safe and every group carries a label", () => {
    const ids = PORTFOLIO_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of PORTFOLIO_GROUPS) {
      // Anchor hrefs are `#${id}` — keep ids URL-fragment safe.
      expect(g.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(g.label.length).toBeGreaterThan(0);
    }
  });
});

// A section composed entirely of self-gating cards must not render a bare
// heading + dead anchor chip when every member gates itself to null. The
// group filter drives BOTH the anchor row and the section rendering, so a
// chip can never point at a section that isn't there.
describe("visiblePortfolioGroups", () => {
  test("clients and money always render; the self-gating pair follows its flags", () => {
    expect(
      visiblePortfolioGroups({ compliance: true, connections: true }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "compliance", "connections"]);
    expect(
      visiblePortfolioGroups({ compliance: false, connections: false }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money"]);
  });

  test("each flag drops exactly its own group, order preserved", () => {
    expect(
      visiblePortfolioGroups({ compliance: false, connections: true }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "connections"]);
    expect(
      visiblePortfolioGroups({ compliance: true, connections: false }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "compliance"]);
  });
});

describe("card-content predicates (shared by card gate and section occupancy)", () => {
  test("calendarHasContent mirrors the calendar card's quiet-month gate", () => {
    expect(calendarHasContent(undefined)).toBe(false);
    expect(calendarHasContent({ days: [], overdue: { invoices: 0 } })).toBe(
      false,
    );
    expect(calendarHasContent({ days: [{}], overdue: { invoices: 0 } })).toBe(
      true,
    );
    expect(calendarHasContent({ days: [], overdue: { invoices: 2 } })).toBe(
      true,
    );
  });

  test("rejectionsHaveContent mirrors the rejection card's quiet-firm gate", () => {
    expect(rejectionsHaveContent(undefined)).toBe(false);
    expect(rejectionsHaveContent({ rows: [] })).toBe(false);
    expect(rejectionsHaveContent({ rows: [{}] })).toBe(true);
  });
});

// ---- Getting-started checklist ----------------------------------------------
// Five steps computed from data the page already holds. Consent is an info
// row by design — the portfolio payload cannot see it, so the card must
// never pretend to.

const FRESH_FIRM = {
  clientCount: 0,
  hasClientInvite: false,
  invoiceCount: 0,
  submittedCount: 0,
};

describe("gettingStartedSteps", () => {
  test("renders the five steps in onboarding order, consent as info", () => {
    const steps = gettingStartedSteps(FRESH_FIRM);
    expect(steps.map((s) => s.id)).toEqual([
      "add-client",
      "invite-owner",
      "consent",
      "first-invoice",
      "stamping",
    ]);
    expect(steps.map((s) => s.kind)).toEqual([
      "step",
      "step",
      "info",
      "step",
      "step",
    ]);
    // A fresh firm has done nothing.
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  test("each step checks off from its own input", () => {
    const steps = gettingStartedSteps({
      clientCount: 2,
      hasClientInvite: true,
      invoiceCount: 5,
      submittedCount: 1,
    });
    const done = Object.fromEntries(steps.map((s) => [s.id, s.done]));
    expect(done).toEqual({
      "add-client": true,
      "invite-owner": true,
      consent: false, // info rows never check
      "first-invoice": true,
      stamping: true,
    });
  });
});

describe("completedStepCount / shouldShowGettingStarted", () => {
  test("only checkable steps count toward completion", () => {
    expect(completedStepCount(gettingStartedSteps(FRESH_FIRM))).toBe(0);
    expect(
      completedStepCount(
        gettingStartedSteps({
          clientCount: 1,
          hasClientInvite: true,
          invoiceCount: 1,
          submittedCount: 1,
        }),
      ),
    ).toBe(4);
  });

  test("shows for an empty book and while fewer than 3 steps are done", () => {
    const empty = gettingStartedSteps(FRESH_FIRM);
    expect(
      shouldShowGettingStarted({ clientCount: 0, steps: empty, dismissed: false }),
    ).toBe(true);

    const two = gettingStartedSteps({
      clientCount: 1,
      hasClientInvite: true,
      invoiceCount: 0,
      submittedCount: 0,
    });
    expect(
      shouldShowGettingStarted({ clientCount: 1, steps: two, dismissed: false }),
    ).toBe(true);
  });

  test("hides once 3 checkable steps are done and the book has clients", () => {
    const three = gettingStartedSteps({
      clientCount: 1,
      hasClientInvite: true,
      invoiceCount: 1,
      submittedCount: 0,
    });
    expect(
      shouldShowGettingStarted({
        clientCount: 1,
        steps: three,
        dismissed: false,
      }),
    ).toBe(false);
  });

  test("dismissal always wins — even on an empty book", () => {
    const empty = gettingStartedSteps(FRESH_FIRM);
    expect(
      shouldShowGettingStarted({ clientCount: 0, steps: empty, dismissed: true }),
    ).toBe(false);
  });
});

describe("checklist inputs from the portfolio payload", () => {
  test("invoice count sums totalInvoices across the book", () => {
    expect(portfolioInvoiceCount([])).toBe(0);
    expect(
      portfolioInvoiceCount([{ totalInvoices: 2 }, { totalInvoices: 3 }]),
    ).toBe(5);
  });

  test("submitted count is stamped + pending — the fields that prove a submission", () => {
    expect(portfolioSubmittedCount([])).toBe(0);
    expect(
      portfolioSubmittedCount([
        { stampedCount: 0, pendingCount: 1 },
        { stampedCount: 2, pendingCount: 0 },
      ]),
    ).toBe(3);
  });

  test("an owner invite means a client_user invitation of any status", () => {
    expect(hasClientOwnerInvite(undefined)).toBe(false);
    expect(hasClientOwnerInvite([{ role: "firm_staff" }])).toBe(false);
    expect(
      hasClientOwnerInvite([{ role: "firm_staff" }, { role: "client_user" }]),
    ).toBe(true);
  });
});

describe("getting-started dismissal storage", () => {
  test("the key is the documented console.gettingStarted.dismissed", () => {
    expect(GETTING_STARTED_DISMISS_KEY).toBe("console.gettingStarted.dismissed");
  });

  test("write marks, read observes — round trip through a fake storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readGettingStartedDismissed(storage)).toBe(false);
    writeGettingStartedDismissed(storage);
    expect(store.get(GETTING_STARTED_DISMISS_KEY)).toBe("1");
    expect(readGettingStartedDismissed(storage)).toBe(true);
  });

  test("a throwing storage (private mode) reads as not-dismissed, never throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readGettingStartedDismissed(throwing)).toBe(false);
    expect(() => writeGettingStartedDismissed(throwing)).not.toThrow();
    expect(readGettingStartedDismissed(null)).toBe(false);
  });
});
