# UX audit R64 — August 2026

The working records of the R64 platform-wide usability round (NN/g
five-component framework, scoped to the R62 launch profile: implementation
effort went to launch-active surfaces; staged surfaces were audited and their
findings deferred to the activation rounds).

| File                                     | What it is                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findings-register.json`                 | All 102 audit findings: area, files, severity, NN/g component, user groups, launch-active flag, evidence, proposed fix. Produced by a 15-agent audit workflow, ranked severity-first.                                                                                                                                                                                             |
| `backlog-deferred.json`                  | Historical snapshot of the findings not implemented in their original round: 37 from R64 (all five remaining highs sit on launch-dark surfaces — Clerk, filing cockpit, Buyer Rails — first in line for their activation rounds) plus 3 from the R67 cognitive walkthrough. The three R67 findings are resolved by the current invitation, navigation, and operation-status work. |
| `cognitive-walkthrough.md`               | R67: three-question cognitive walkthrough of the two first-run flows (operator invites a client; invited client user reaches their first stamped invoice), executed against the built stack. One high finding (post-submit status contradiction) fixed in-round; the rest deferred to the backlog.                                                                                |
| `moderated-usability-protocol.md`        | Recruitment, tasks, privacy controls, measures, and release thresholds for the real-user sessions that must follow the heuristic implementation. It is a protocol, not fabricated research results.                                                                                                                                                                               |
| `inventory-routes.json`                  | 72-route inventory across the five web apps: purpose, launch-active state, and which empty/loading/error states each page handles.                                                                                                                                                                                                                                                |
| `inventory-components.md`                | Design-system inventory: shared vs per-app components, duplication, gaps, status-color practice.                                                                                                                                                                                                                                                                                  |
| `inventory-flows.md`                     | The six primary task flows as mapped from code, with context losses and dead ends called out.                                                                                                                                                                                                                                                                                     |
| `a11y-baseline.json` / `a11y-after.json` | Per-page accessibility issue lists from `scripts/src/e2e/ux-snapshot.mjs` over 14 key signed-in pages, before (8 issues) and after (0 issues) the round.                                                                                                                                                                                                                          |

Measurement harness: `scripts/src/e2e/ux-snapshot.mjs` (boots the built stack
on a scratch DB, signs in as the seeded demo identities, records per-page
accessibility issues + full-page screenshots). Screenshots are not committed;
re-run the harness to regenerate them.

65 findings were adversarially verified into implementation specs and applied
in R64 (three implementation waves plus a heading-level fix). Of the 41
entries the deferred backlog then carried (37 from R64, three from the R67
cognitive walkthrough, one D16 follow-through), the 20 on launch-active
surfaces were closed by R69–R87 — the shell and page-body restyle, then the
four launch-active rounds R84–R87 — and removed from
`backlog-deferred.json`. The 21 that remain all sit on launch-dark surfaces
(filing desk, Ask/Clerk dock, batch capture, buyer portal) and are the next
candidates once those flags light.
