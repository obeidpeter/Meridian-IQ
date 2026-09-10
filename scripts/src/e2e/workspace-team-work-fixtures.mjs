import assert from "node:assert/strict";
import { shellFixtures } from "./workspace-usability-fixtures.mjs";

export const applications = [
  {
    prefix: "console",
    artifact: "console",
    role: "firm_admin",
    title: "What needs attention",
    todayPath: "/today",
  },
  {
    prefix: "app",
    artifact: "sme-compliance",
    role: "client_user",
    title: "Your business today",
    todayPath: "/",
  },
  {
    prefix: "buyer",
    artifact: "buyer-portal",
    role: "buyer_user",
    title: "Buyer work today",
    todayPath: "/",
  },
];

const longClient = `Client${"LongLegalReference".repeat(10)}`;
const longDescription = `Handoff ${"UnbrokenEvidenceReference".repeat(10)}`;
export const longTitle = `Task 001 ${"LongTitle".repeat(12)}`;

export function createTeamFixture(app) {
  const shell = shellFixtures();
  const me = {
    ...shell["/api/me"],
    userId: "fixture-user",
    firmId: "fixture-firm",
    role: app.role,
    clientPartyId: app.prefix === "app" ? "fixture-client" : null,
    buyerPartyId: app.prefix === "buyer" ? "fixture-buyer" : null,
    capabilities: [
      "console.portfolio.read",
      "work.read",
      "work.write",
      "invoice.read",
    ],
  };
  const makeItem = (index, status = "open") => ({
    id: `${status === "done" ? "done" : "active"}-${String(index).padStart(3, "0")}`,
    clientPartyId: "fixture-client",
    clientName: index === 1 ? longClient : "Fixture client",
    title:
      index === 1 && status !== "done"
        ? longTitle
        : `${status === "done" ? "Completed" : "Task"} ${String(index).padStart(3, "0")}`,
    description:
      index === 1 ? longDescription : "Review the supporting records.",
    status,
    priority: "normal",
    dueAt: null,
    assignedTo: "fixture-user",
    assignedToName:
      index === 1 ? `Reviewer${"LongName".repeat(8)}` : "Fixture reviewer",
    createdByName: "Fixture accountant",
    href: null,
    version: 1,
    updatedAt: "2026-09-09T08:00:00Z",
  });
  const active = Array.from({ length: 125 }, (_, index) => makeItem(index + 1));
  const done = Array.from({ length: 3 }, (_, index) =>
    makeItem(index + 1, "done"),
  );
  const today = {
    generatedAt: "2026-09-09T08:00:00Z",
    summary: {
      total: 1,
      urgent: 1,
      dueSoon: 0,
      blocked: 0,
      completedSetupSteps: 0,
      totalSetupSteps: 0,
    },
    items: [
      {
        id: "retained-priority",
        title: "Retained priority evidence",
        description: "This priority must remain visible after refresh fails.",
        priority: "urgent",
        status: "open",
        source: "team_work",
        clientName: "Fixture client",
        dueAt: null,
        href: "/work",
      },
    ],
    setup: [],
  };
  const state = {
    me,
    active,
    done,
    today,
    listError: false,
    discussionError: true,
    todayError: false,
    dropNextCommentResponse: true,
    listRequests: [],
    commentAttempts: [],
    savedComments: new Map(),
    unexpected: [],
    telemetry: [],
    todayRequests: 0,
    pending: [],
    holdNextPage: false,
  };
  const fixtures = {
    ...shell,
    "/api/me": me,
    "/api/console/portfolio": { clients: [] },
    "/api/console/team": [],
  };
  const fail = (route, message) =>
    route.fulfill({
      status: 503,
      json: { error: "FIXTURE_UNAVAILABLE", message },
    });
  const releasePages = async () => {
    state.holdNextPage = false;
    for (const release of state.pending.splice(0)) await release();
  };
  async function install(context, origin) {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin === "https://fonts.googleapis.com" &&
        url.pathname === "/css2"
      )
        return route.fulfill({
          contentType: "text/css",
          body: "/* Synthetic offline fixture uses fallback fonts. */",
        });
      if (url.origin !== origin) {
        state.unexpected.push(
          `${request.method()} ${url.origin}${url.pathname}`,
        );
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/") && request.method() === "GET")
        return route.continue();
      try {
        if (request.method() === "GET") {
          if (url.pathname === "/api/work-items/page") {
            const params = Object.fromEntries(url.searchParams);
            state.listRequests.push(params);
            assert.equal(
              params.limit,
              "50",
              "Work page must explicitly request 50 items",
            );
            assert.ok(
              ["active", "done", "all"].includes(params.view),
              "View is explicit and supported",
            );
            assert.ok(
              Object.keys(params).every((key) =>
                ["view", "limit", "cursor"].includes(key),
              ),
            );
            if (state.listError)
              return fail(route, "Synthetic task list unavailable");
            const records =
              params.view === "active"
                ? active
                : params.view === "done"
                  ? done
                  : [...active, ...done];
            let offset = 0;
            if (params.cursor) {
              const match = /^fixture-(active|done|all)-(50|100)$/.exec(
                params.cursor,
              );
              assert.ok(
                match && match[1] === params.view,
                "Cursor remains bound to its view",
              );
              offset = Number(match[2]);
            }
            const json = {
              items: records.slice(offset, offset + 50),
              total: records.length,
              nextCursor:
                offset + 50 < records.length
                  ? `fixture-${params.view}-${offset + 50}`
                  : null,
            };
            if (params.cursor && state.holdNextPage)
              return new Promise((resolve) =>
                state.pending.push(async () => {
                  try {
                    await route.fulfill({ json });
                  } finally {
                    resolve();
                  }
                }),
              );
            return route.fulfill({ json });
          }
          const comments =
            /^\/api\/work-items\/((?:active|done)-\d{3})\/comments$/.exec(
              url.pathname,
            );
          if (comments) {
            if (state.discussionError && comments[1] === "active-001")
              return fail(route, "Synthetic discussion unavailable");
            return route.fulfill({
              json: [...state.savedComments.values()].filter(
                (comment) => comment.workItemId === comments[1],
              ),
            });
          }
          if (url.pathname === "/api/workspace/today") {
            state.todayRequests += 1;
            return state.todayError
              ? fail(route, "Synthetic Today refresh unavailable")
              : route.fulfill({ json: today });
          }
          if (Object.hasOwn(fixtures, url.pathname))
            return route.fulfill({ json: fixtures[url.pathname] });
        }
        if (
          request.method() === "POST" &&
          url.pathname === "/api/public/usability-events"
        ) {
          const body = request.postDataJSON();
          assert.deepEqual(body, {
            event: "collaboration_comment_added",
            surface: "collaboration",
          });
          state.telemetry.push(body);
          return route.fulfill({ status: 202, json: { ok: true } });
        }
        const commentPost =
          /^\/api\/work-items\/(active-\d{3})\/comments$/.exec(url.pathname);
        if (request.method() === "POST" && commentPost) {
          const body = request.postDataJSON();
          assert.deepEqual(Object.keys(body).sort(), [
            "body",
            "clientRequestId",
          ]);
          assert.match(
            body.clientRequestId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          assert.ok(body.body.trim().length > 0 && body.body.length <= 2000);
          state.commentAttempts.push({ workItemId: commentPost[1], ...body });
          const key = `${commentPost[1]}:${body.clientRequestId}`;
          const existing = state.savedComments.get(key);
          if (existing)
            assert.equal(
              existing.body,
              body.body,
              "A retry cannot reuse its key for different content",
            );
          const comment = existing ?? {
            id: `comment-${state.savedComments.size + 1}`,
            workItemId: commentPost[1],
            body: body.body,
            authorName: "Fixture reviewer",
            createdAt: "2026-09-09T08:00:00Z",
          };
          state.savedComments.set(key, comment);
          if (state.dropNextCommentResponse) {
            state.dropNextCommentResponse = false;
            return route.abort("failed");
          }
          return route.fulfill({ status: 201, json: comment });
        }
        throw new Error(`Unimplemented ${request.method()} ${url.pathname}`);
      } catch (error) {
        state.unexpected.push(String(error));
        return route.fulfill({
          status: 501,
          json: { error: "UNIMPLEMENTED_FIXTURE" },
        });
      }
    });
  }
  return { state, install, releasePages };
}
