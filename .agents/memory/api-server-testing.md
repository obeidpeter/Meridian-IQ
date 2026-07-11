---
name: api-server test/build setup
description: How tests and builds run in the api-server package.
---

# api-server: tests via node --test, build via esbuild

- Node 24 runs TypeScript directly, so `node --test "src/**/*.test.ts"` works with no test-runner dependency (see the `test` script). ESM requires explicit `.ts` extensions in test imports (e.g. `./canonical.ts`).
- `allowImportingTsExtensions` + `noEmit` are set in tsconfig; this is safe because production builds go through esbuild (`build.mjs`), and `tsc` is used only for typechecking (`--noEmit`).
- Golden invariant tests live next to their module (e.g. `src/modules/invoice/canonical.test.ts`) and cover pure functions (UBL/JSON round-trip). DB-backed invariants are exercised via live smoke, not unit tests.
- The package `test` script is `tsx --test`, not plain `node --test`. Plain node fails on any test whose import graph contains extensionless relative imports (e.g. route tests pulling in `lib/api-zod`, or anything importing `modules/pipeline/pipeline`); tsx resolves them. Prefer targeted `node --test <file>` for extension-clean module tests, tsx for route tests.
- A full `tsx --test` run can stall without exiting after most files pass (lingering keep-alive handle, pre-existing); run stragglers per-file instead of waiting.
- Modules that need a pipeline sweep AND have node-test unit tests should register the sweep in a separate `register.ts` (imported from `routes/index.ts`) so the test can import the module without dragging in the pipeline worker's extensionless import graph.
