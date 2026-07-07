---
name: api-server test/build setup
description: How tests and builds run in the api-server package.
---

# api-server: tests via node --test, build via esbuild

- Node 24 runs TypeScript directly, so `node --test "src/**/*.test.ts"` works with no test-runner dependency (see the `test` script). ESM requires explicit `.ts` extensions in test imports (e.g. `./canonical.ts`).
- `allowImportingTsExtensions` + `noEmit` are set in tsconfig; this is safe because production builds go through esbuild (`build.mjs`), and `tsc` is used only for typechecking (`--noEmit`).
- Golden invariant tests live next to their module (e.g. `src/modules/invoice/canonical.test.ts`) and cover pure functions (UBL/JSON round-trip). DB-backed invariants are exercised via live smoke, not unit tests.
