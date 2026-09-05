# Architecture Decision Records

ADRs record decisions whose rationale is easy to lose during implementation.
They complement the chronological decision log in `docs/architecture.md`.

| ADR                                          | Status   | Decision                                                        |
| -------------------------------------------- | -------- | --------------------------------------------------------------- |
| [0001](0001-central-request-policy.md)       | Accepted | Centralize transaction and model-capacity route policy          |
| [0002](0002-deterministic-build-profiles.md) | Accepted | Keep clean web/API builds independent of deployment environment |
| [0003](0003-maintainability-gates.md)        | Accepted | Enforce dependency boundaries and secret hygiene in CI          |
| [0004](0004-release-profiles.md)             | Accepted | Release profiles: pilot by default, governed on request         |

Create a new numbered record for a significant cross-package, security,
storage, integration, or operational decision. Do not rewrite accepted history;
supersede it with a new ADR.
