# Workspace usability validation

Status: **human usability validation has not been conducted for this change**.
This document is a protocol and blank evidence template, not a study result.
Automated fixtures, screenshots, developer inspection, and axe results do not
prove task comprehension, screen-reader usability, or real-user success.

This focused protocol complements [the wider pilot](usability-pilot.md) and
[the moderated workflow protocol](ux-audit-2026-08/moderated-usability-protocol.md).
It covers daily work, team handoff, and interpreting integration reliability.
Automated coverage includes reliability, onboarding guidance, team discussion,
pagination, and stale workspace recovery.

## Engineering checks

Install the development prerequisites described in [development](development.md),
then run from the repository root:

```sh
pnpm --filter @workspace/console exec vitest run src/pages/control-centre/reliability.test.tsx src/pages/control-centre/accessibility.test.tsx
pnpm --filter @workspace/web-ui exec vitest run src/semantic-contrast.test.ts src/workspace.test.tsx
pnpm --filter @workspace/console run typecheck
pnpm --filter @workspace/console --filter @workspace/sme-compliance --filter @workspace/buyer-portal run build
pnpm run test:workspace-usability
```

Run an individual suite while diagnosing a failure:

```sh
node --test scripts/src/e2e/workspace-usability.test.mjs
node --test scripts/src/e2e/workspace-usability-hooks.test.mjs
node --test scripts/src/e2e/workspace-team-work.test.mjs
```

The browser suite needs Node 22.18+ (native type stripping for the existing
TypeScript fixtures), the repository's Playwright dependency, and a compatible
Chromium executable. If Chromium is already installed outside Playwright's
default cache, set `PLAYWRIGHT_EXECUTABLE_PATH` to that local executable. Otherwise
install Chromium with `pnpm --filter @workspace/scripts exec playwright install chromium`.
CI runs `pnpm run test:workspace-usability` after building the frontend assets
and installing the browser. Do not rebuild `dist` while a browser run is using it.

The reliability suite reuses `scripts/src/e2e/serve.mjs`, `accessibility.mjs`, and the existing
control-centre response fixture. It serves built console assets on an ephemeral
loopback port, blocks service workers, and fulfills allowlisted GET requests.
Unexpected network requests and all mutations fail the test; no database,
production URL, credentials, external notifications, or live provider is used.
The Google Fonts stylesheet is replaced locally with an empty stylesheet, so
evidence explicitly records fallback-font rendering.

The 28 scenarios include:

- Populated long/unbroken client, firm, connector, diagnostic, and signal values
  at 320, 390, 768, 1024, and 1440 CSS pixels, in light and dark themes.
- Large numeric values, green/amber/red status text, warning diagnostics,
  critical row-error counts, and zero-count signal suppression.
- Truncated lists with full-population counts, missing last-sync/run values,
  empty responses, deliberately held loading, HTTP 503, and successful retry.
- Keyboard-only filter activation and retry, pressed state, unchanged summary
  totals, investigation link destinations, and minimum 44px controls. The
  44px floor is measured on every visible control inside the workspace
  region; the repo-wide accessibility gate holds every icon control to the
  24px WCAG minimum, and the app-shell stale-build banners dismiss at 44px
  as well (R115).
- Element-level clipping, overlapping facts/filters/status, workspace/page
  overflow, computed semantic token colors, and the existing whole-page axe,
  reduced-motion, focus, and 320px reflow checks.
- A 200% root-text enlargement case per theme. This is **not native browser
  zoom** and does not double fixed-pixel text. Test real zoom separately below.

Each run writes timestamped `tmp/workspace-usability/<run>/` screenshots,
per-state measurements, raw axe output, and `report.json`. Loading/error cases
also capture the recovered state. A failed interaction records a failure
screenshot and reason. Check that every expected case passed; the existence of
screenshots is not a pass. Rebuild before testing changed source, and record the
base revision plus dirty-worktree diff fingerprint with evidence. A base commit
alone does not identify a build made from a shared dirty tree.

The companion hook suite uses the compiled Today and Team work pages at 320,
768, and 1440 CSS pixels in both themes. It checks long recommended-next-step
labels, a nonshrinking arrow, unframed next-step spacing, blocked/waiting warning
text, readable disabled setup buttons, discussion-error retry layout, and the
paginated list's count/load-more/loading states. It allows only local GET
fixtures and writes separate `tmp/workspace-usability-hooks/<run>/` screenshots
and measurements. These checks complement the component and API behavioral tests.

The Team work suite requires built Console, SME, and Buyer apps. Wait for any
build to finish before running it; concurrent replacement of `dist`
assets can invalidate a browser run. Its compact 13-case matrix consists of
eight Console/SME journeys (320/1440px, light/dark), two initial list-failure
recoveries, and three stale Today recoveries (Console/SME/Buyer at 320px dark).
It verifies 125 active tasks in 50/50/25 pages, view-bound cursor parameters,
count updates and fresh first pages for Completed/All, selection of task 125,
task-specific comment drafts in user/firm/client-scoped session keys, reload
persistence, discussion errors and retry, and a committed comment whose first
response is deliberately dropped. The second POST must carry the identical
`clientRequestId` and body; the fixture retains exactly one comment. This tests
the browser's retry contract, not real server idempotency or tenant isolation.

Only synthetic comment POSTs and the expected aggregate usability-event POST
are allowed in this suite; every other mutation or external request fails.
Stale Today uses a controlled browser clock and visibility notification to
exercise React Query's real stale-on-focus fetch, then confirms the existing
priority survives both failure and retry. No query-cache internals are patched.
Long task/client/assignee values receive element-level overflow checks plus
whole-page axe/reflow checks. Evidence is separate in
`tmp/workspace-team-work/<run>/`; screenshots use the viewport rather than
emitting the entire 125-row list as a very tall image.

For an explicitly partial diagnostic run while only Console is built:

```sh
node --test --test-name-pattern=console scripts/src/e2e/workspace-team-work.test.mjs
```

`report.json` marks such a subset with `completeMatrix: false`. Missing required
builds fail rather than skip. Use the complete workspace command for the CI gate;
a filtered diagnostic run is not complete validation.

The existing `control-centre/accessibility.test.tsx` caption regression now
checks the theme-aware paper/muted tokens and label/value association instead
of requiring fixed-white/slate utilities. Computed colors and real contrast
remain covered by the browser suite's token measurements and axe results.
Other control-centre pages are not reskinned.

## Manual engineering review

Use synthetic accounts on an approved isolated build. Record exact build,
browser, OS, zoom, viewport in CSS pixels, theme, font availability, and device.
Inspect screenshots for readable line lengths and sensible grouping, not just
absence of overflow. Use physical touch devices where available.

1. Test browser zoom at 200% and 400% from a 1280px-wide desktop window, and
   native text enlargement on mobile. Read complete client/connector values,
   switch every filter, and identify each row's run, throughput, and errors.
2. Check Tab/Shift+Tab order, Enter/Space activation, focus visibility and
   visibility after scrolling. Open the navigation drawer on mobile and return
   to the workspace. Do not use mouse clicks to claim keyboard completion.
3. With a screen reader used by the tester, inspect heading/region navigation,
   filter names and pressed state, label/value association, loading, empty,
   error, and retry transitions. Record exact announcements and any silence.
4. Confirm full totals are not mistaken for the number of visible rows in the
   truncated fixture. Check an empty filter independently of active signals.
5. Check the same records in both themes, reduced motion, and forced-colors
   mode. Note unsupported or untested combinations explicitly, without waivers
   hidden in an automated allowlist.

## Moderated study

Assign a study owner, facilitator, observer, recruitment owner, and decision
owner before scheduling. Plan 8-10 participants: 3 SME finance users, 3 firm
staff who manage multiple clients, and 2-4 operations/support users who diagnose
integrations. Include new and returning users, mobile users on constrained
connections, and at least two participants who routinely use keyboard-only or
assistive technology across these roles. Document recruitment gaps. Developers
and stakeholders can pilot the script but do not replace target participants.

Book 45-minute one-to-one sessions: 5 minutes consent/context, 5 minutes recent
work habits, 25 minutes role-relevant tasks, and 10 minutes debrief. Pilot with
one colleague to find fixture/script defects; label and exclude that session
from participant completion results. Pay agreed compensation regardless of
performance or withdrawal. Stop or reschedule when fixtures fail.

Before consent, explain the purpose, voluntary participation, recording choices,
withdrawal process, storage location, access list, and deletion date. Confirm
consent separately for participation and recording. Use pseudonymous IDs and
synthetic records. Never collect passwords, MFA codes, live invoices, or actual
customer data. Keep recordings and contact details outside the repository in
restricted storage; agree a retention period (proposed: 30 days after synthesis)
and assign its deletion owner. Do not run sessions against production.

Opening script: "We are testing this workspace, not you. Please work as you
normally would and say what you are looking for and expecting. You can stop at
any time. I may hold back help so we can see where the design is unclear."

Give tasks as goals, one at a time, without naming controls. Use only tasks
relevant to the participant's role; record skipped tasks and the denominator.
Counterbalance before/after build order with equivalent datasets when comparing
versions. Do not describe the UI changes before participants attempt the tasks.

| ID  | Participant prompt                                                                                                                         | Facilitator setup and observable success                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | "You have ten minutes before a client call. Decide what you will work on first and explain why."                                           | Seed urgent, blocked, due-soon, and completed work. Participant distinguishes status and priority and locates relevant context. Do not require an invented universal correct priority.                                         |
| W2  | "A colleague is taking over this client's unfinished item. Make the next step clear, then return to it from your usual starting point."    | Use approved non-production work fixtures. Participant chooses the intended client/item, records the handoff where supported, and finds the same item again. Observe lost context or mistaken completion.                      |
| R1  | "An accountant says their client's latest records have not appeared. Find which connection needs investigation and explain what happened." | Seed healthy, stale, and incident connections with long similar identifiers. Success identifies the intended tenant, distinguishes freshness from failure, reads row errors, and locates a relevant investigation destination. |
| R2  | "Prepare a brief update on the whole connection estate. Is the list you can see the whole estate? What remains uncertain?"                 | Use truncated response and one missing sync/run. Success distinguishes visible rows from population totals and does not invent a successful run or claim all records are healthy.                                              |
| R3  | "The view cannot load. Find out whether you can continue and recover it when the service returns."                                         | Hold a local synthetic 503, then release after the participant chooses a recovery route. Success recognizes unavailable data rather than a clear/healthy state and recovers without unintended writes.                         |
| R4  | "You are away from your desk. Find the bank-feed connections and report the full identifier and most recent outcome for this client."      | Use participant's normal mobile/input method with long values and both themes in counterbalanced order. Success reads the complete identifier and relevant facts without losing filters or confusing rows.                     |

During a task, allow silence. Neutral prompts include "What are you looking
for?" and "What do you expect to happen?" Do not point, name the target filter,
or suggest retry. After two minutes without progress, ask whether they wish to
continue; cap a task at five minutes. Record the time and exact prompt before
assisting. Once directional help is given, completion is assisted, not unaided.
Stop immediately for distress, accidental real data, or unintended live action.

After each task ask: "How easy or difficult was that?" (1 very difficult to 7
very easy), "How confident are you in the result?" (1-5), and "What tells you
that?" In debrief ask what they would do next, what they mistrusted, and how the
experience compares with their actual workflow. Separate observed behavior
from stated preference and facilitator interpretation.

## Evidence template

Leave unknown fields blank or marked "not observed". Never populate examples as
participant findings. Store session-level evidence outside source control.

```text
Study ID / owner / decision owner:
Build revision + dirty diff fingerprint / build date:
Environment and synthetic dataset version:
Session ID (pseudonym) / date / role / prior experience:
Consent record / recording permission / restricted evidence location:
Retention deadline / deletion owner:
Device / OS / browser / viewport / theme / zoom / input / assistive technology:
Network condition / fonts / before-after order:

Task ID / start / end / elapsed seconds:
Outcome: unassisted | assisted | failed | abandoned | not attempted
First action / wrong turns / backtracks / repeated actions:
Observed behavior (timestamped, factual):
Participant quote (verbatim only with evidence reference):
Prompts and assistance (exact words + timestamps):
State understood? / recovery outcome / unintended action:
Ease 1-7 / confidence 1-5 / participant explanation:
Evidence reference / observer / fixture or recording limitations:

Finding ID / affected role and task / severity:
Observed evidence / interpretation (separate):
Frequency n/N eligible participants / contradictory observations:
Proposed change / owner / target date / linked issue:
Retest build / participants / result / remaining uncertainty:
```

## Decision and follow-through

Agree decision criteria before recruitment. Proposed minimums: no unresolved
critical wrong-tenant, false-healthy, duplicate-action, or accessibility blocker;
at least 80% unassisted completion per enabled critical task; median confidence
at least 4/5. Always publish raw n/N by task and role. These are directional
small-sample decision thresholds, not population estimates or certification;
do not average away an affected-role blocker or exclude assisted sessions.

Triage within two working days: critical = harmful/misleading outcome or cannot
proceed; major = assistance/workaround required; minor = recoverable friction.
Every critical/major finding needs an owner and retest with at least two users
from the affected role, including the relevant assistive technology when
applicable. Track lesser findings and recruitment gaps with dates.

The decision record must include actual session dates and counts, task outcomes,
evidence links, unresolved findings, owners, and approval/hold rationale. Keep
engineering and participant evidence in separate sections. Until genuine
sessions are completed and reviewed, report "automated checks performed;
moderated-user validation pending", never "validated with users".
