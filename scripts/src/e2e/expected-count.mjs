// The documented size of the standard seeded e2e run (R105 drift guard). CI
// fails the run when the executed total differs, and the docs-drift test
// fails when CLAUDE.md, replit.md or the user manual state another number —
// so the figure in the docs can no longer go stale silently. Update this
// constant and the three documents together when journeys are added.
export const EXPECTED_E2E_CHECKS = 433;
