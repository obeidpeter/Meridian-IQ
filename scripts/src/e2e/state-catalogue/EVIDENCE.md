# R198 Catalogue and Journal Handoff

Verified locally on 2026-09-04. Shared-worktree source; no commit or deployment.

## Readiness

- All seven remaining operation writers/pages use the full firm/user/client key.
- Both Activity pages use the shared stable authorized `useSessionOperations`
  hook and pass sync state, refresh and recovery callbacks. Their original page
  headers render again; layouts retain the operation-history dialog.
- No raw `meridianiq:operations:` string remains in production console, SME or
  buyer source. Old unscoped records are intentionally not restored.
- The optional membership switcher remains deferred; exact server requirements
  and the current endpoint limitations are documented in `README.md`.

## Browser Evidence

Playwright drove installed Chromium/Chrome **152.0.7977.77** at 320/768/1440,
light/dark, reduced motion, plus 320px at 200% root text size in both themes.

- Final full catalogue: **88 screenshots, zero axe violations, zero geometry or
  action-readability failures**. Report generated `2026-09-04T22:12:19.126Z`.
  `tmp/state-catalogue-r198/report.json`, sibling PNGs and full `*.axe.json`.
- Focused partial/dialog/disabled run: **24 specimens, zero failures** in
  `tmp/state-catalogue-r198/followup`. The final full run supersedes this run and
  the earlier 77-specimen catalogue.
- 24 full-run interaction checks cover keyboard lazy-import retry, pending
  disabled controls, and dialog focus trapping/restoration. Dialog controls must
  scroll into view and display visible keyboard focus; saved results must be
  keyboard reachable. Forbidden fixtures render no operation records.
- Loading region measured 320px high at all three widths in both themes; 640px
  under 200% root text enlargement. No horizontal overflow, clipped visible text,
  buttons below 24px, or active reduced-motion animations were detected.
- Actual browser findings fixed: long-email clipping; shortcut-dialog list styles
  overriding the activity grid; non-keyboard-scrollable saved results; unnamed
  generic result container; constrained action wrapping; running spinner motion.

### Final Readability Fix

The preceding 77-specimen run passed automated overflow checks, but manual review
found letter-by-letter action labels at 320px/200% text. It was not accepted as a
clean rendered pass. Recovery actions now use full-width rows in constrained
containers, reserve no adjacent dismissal column, and wrap only between words.
Recovery-dialog gutters and padding retain usable space as text enlarges. Font
sizes, design tokens, normal desktop action placement and route behavior did not change.

The new browser check measures each word's DOM rectangles, label line count,
usable text width and required intact-word width. Three browser self-tests prove
that it rejects split words without overflow, rejects insufficient usable width,
and accepts normal word wrapping. In the final 320px/200% dialogs, both action
labels have **140px usable width**, wrap into **two lines**, and have **zero split
words** in both themes. Their widest words require 77.625px and 72.28125px.

Manual review passed for partial and dialog enlarged-text screenshots, and dialog
screenshots at 768/1440 in both themes. The final light/dark
`dialog-*-320-text200.png` files show intact "Open source" and "Verify result"
labels, with Dismiss on its own row. No remaining blocking visual defect was found
in these reviewed states.

Automated axe is not complete WCAG certification. Remaining incomplete checks
cover Radix's hidden background/focus guards and contrast on partially scrolled
dialog content. Keyboard trapping/restoration was exercised; manual screen-reader
and real browser-zoom review remain integration checks. Text enlargement is not
browser zoom. The catalogue uses synthetic data and does not prove server RBAC/RLS.

## Bundle Ratchet

**Implemented and passed**, not deferred. Fresh five-app builds, Vite manifests,
and logs are retained in `tmp/route-budget-r198`; see `report.json`.

| App | Eager JS gzip bytes | Delta from pre-UI-fix run | Fixed ceiling | Lazy entries |
| --- | ---: | ---: | ---: | ---: |
| console | 164,396 | +6 | 166,000 | 33 |
| sme-compliance | 159,233 | +9 | 160,500 | 26 |
| buyer-portal | 133,833 | +22 | 135,000 | 8 |
| landing | 70,751 | 0 | 71,500 | 6 |
| penalty-calculator | 61,222 | +1 | 62,000 | 1 |

Counts include transitive static JS imports once per downloaded file. CSS/assets
are excluded. The source ratchet rejects new eager page imports in App/main,
raw operation keys, and production catalogue references. These fresh measurements
include the final route helper, retry integration and recovery readability fix.
The pre-UI-fix measurements were 164,390 / 159,224 / 133,811 / 70,751 / 61,221 bytes.
No ceiling or lazy-entry floor was changed. `route-budgets.json` retained SHA-256
`40AB1031D0A7099A189E13D12169D7A723FE24A304C7A074E2826FA50CBF0DB4` before and after.
The parent owns the final broader architecture/integration gates.

## Other Verification

- Final focused recovery/status suite: **8 tests / 2 files passed**.
- Shared web-ui TypeScript build passed.
- Scoped ESLint passed, including browser globals in the new runner.
- E owns full integration gates and CI wiring. Existing E scripts were not edited.
- Parent-owned invoice-detail, invoice approvals and mobile edit files untouched.

## Exact Files for the Final Readability Fix

```text
lib/web-ui/src/session-operation-recovery.tsx
lib/web-ui/src/operation-status.tsx
lib/web-ui/src/styles.css
scripts/src/e2e/state-catalogue/run.mjs
scripts/src/e2e/state-catalogue/readability.mjs
scripts/src/e2e/state-catalogue/README.md
scripts/src/e2e/state-catalogue/EVIDENCE.md
```

The `tmp` evidence directories are ignored build/test output, not production
assets. Preserve them with the verification artifacts; no package installs,
lockfile, generated API, schema/migration-index, commit or deployment changes
were made for this follow-up.
