# Valo Web Design Refinement

## Scope

Prepared on `agent/valo-reference-refinement` from merged main
`fe60aebb5b4b6ce46381e8d9d16379f4ae68ac94` on 8 September 2026.
This extends the previous public landing redesign to sign-in and the shared
signed-in web experience: Accountant Console, business compliance workspace
and Buyer Rails, including the separate Clerk shell and floating Clerk panel.
The native mobile application is unchanged.

No API, schema, authentication logic, role, tenancy, release flag or deployment
configuration changes. No new dependencies. Existing enquiry consent, honeypot,
generated API client, aggregate analytics, invitation routes and approved
support mailbox are retained.

The supplied Valo reference image informed the compact editorial structure,
visible product scene, thin rules, olive actions and evidence presentation.
The implementation uses the existing Valo mark and original generated
photography; it does not reproduce fictitious authority stamps or invent
legal destinations from the reference.

## Design System

| Surface              | Treatment                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Landing              | Near-white paper, compact benefit strip, full-width audience tabs, interactive illustrative record and dark evidence section |
| Sign-in and recovery | White form-first layout, clear labels, quieter role information and consistent invitation/recovery screens                   |
| Signed-in web apps   | Neutral canvas, white work surfaces, graphite/olive navigation, tighter headings, restrained metrics, ruled tables and tabs  |
| Dark mode            | Neutral graphite surfaces with sage accents; meaningful blue, amber, green and red states retained                           |

| Token                   | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Landing paper           | #f7f8f5                                                      |
| Workspace canvas        | #f5f6f3                                                      |
| Work surface            | #ffffff                                                      |
| Primary ink             | #262925                                                      |
| Muted ink               | #60655d                                                      |
| Decorative rule         | #d5d8d0                                                      |
| Primary action          | #536149                                                      |
| Sidebar / evidence band | #252b24                                                      |
| Typography              | Existing Inter with system fallbacks; fixed breakpoint sizes |
| Landing hero            | 52px desktop, 36px mobile, 32px narrow, 30px short portrait  |
| Landing sections        | 64px desktop, 40px mobile                                    |
| Corners                 | 4px public controls; shared workspace corners at most 8px    |

Public styles are scoped to `.valo-editorial`; auth uses `.valo-auth`.
The three signed-in shells opt into `.mi-platform` and use shared semantic
tokens from `lib/web-ui/src/styles.css`. Legacy teal/gold token names are
retained as compatibility aliases for existing components. Status colors are
independent of brand accents.

Default theme changes do not remove firm-specific theme overrides.
Operations, permissions, destinations, API handling and Clerk's human-review
boundaries are unchanged.

Workspace search now captures its opening control for both controlled click
triggers and keyboard shortcuts. Closing restores focus only to a still-connected
opener; timers are cleaned up, and command selection does not steal focus from
the destination action. Regression tests cover repeated opens, external close,
removed controls and unmounting.

## Landing Interactions

Business and accountant views share a stable frame. Each has functional
Overview, Evidence and History tabs, with arrow, Home and End keyboard support.
Inactive panels retain their layout track but are hidden visually and from
assistive technology. Sample filenames are not fake download controls.

Mobile navigation remains an in-flow disclosure. Escape restores focus to the
trigger. Short portrait screens use compact spacing while retaining the complete
laptop and a hint of the next section. Sign-in remains available in navigation
when its duplicate hero link is hidden.

The primary action is consistently **Request a demo**, routed to the existing
enquiry form. This requests contact; it does not create an account or book a
guaranteed appointment. The form retains values on failure, prevents concurrent
submissions, and moves focus to the result or reset field.

## Copy And Availability

The release flag catalogue, engineering guide and platform/Clerk documentation
remain the source of truth for capability descriptions. The R0 invoice core is
distinguished from firm-activated capabilities and planned Buyer Rails.

All sample invoice, client, evidence and activity content is illustrative.
Internal checks are not authority approvals. No official seal, guarantee,
customer statistic, certification or launch date is invented. Recording
payment evidence does not imply custody or guaranteed payment.

The approved support mailbox is retained. No public privacy or terms pages
were invented; approved public legal policies remain a separate owner/legal
follow-up.

## Photography

Generated with the built-in image tool. Original PNGs are preserved outside
the repository. Sharp was used only for resizing and WebP format optimisation.

Project assets:

- `artifacts/landing/public/valo-workspace-hero.webp`: 1942 x 809,
  91,120 bytes.
- `artifacts/landing/public/valo-workspace-mobile.webp`: 1200 x 600,
  66,890 bytes.

Earlier `valo-records-*` assets and the social image remain for compatibility;
the landing hero now uses the new workspace image pair.

Desktop generation prompt:

> Create one original photorealistic product editorial photograph for the Valo invoicing software website, very wide landscape 2.4:1. A continuous pale neutral-grey limestone desk and softly lit wall fill the entire canvas. Critical website composition: the left 48 percent is evenly lit EMPTY pale grey wall/desk with no objects and no shadows, reserved for a live dark HTML headline. On the RIGHT half is a complete open thin graphite laptop, photographed almost front-on at a slight three-quarter angle, fully visible with screen and keyboard, occupying about 40 percent of total canvas width. Its screen displays a crisp restrained modern invoice workspace: white background, thin grey rules, narrow pale sidebar, small wordmark 'Valo', heading 'Invoices', four rows of fictional invoices for 'Ade Studio', 'Northline Trading', 'Kola Works', 'Ife Design', labelled 'Draft', 'Needs review', 'Checked', 'Draft' with subtle blue, amber and green status labels. No official approvals, tax authority stamps, seals, promises, or real client data. The screen is the main subject and must be recognisably software, sharp not blurred; it is an illustrative product scene. To the right foreground one simple neutral grey notebook and black pen, behind the laptop a small sprig of olive leaves in a matte pale ceramic vase. Understated sunlight, very soft natural shadows, authentic materials, refined Nigerian business workspace with quiet order. Balanced neutral-white, graphite, restrained olive with a tiny blue UI accent. NOT warm sepia, beige-dominated, dark, glossy CGI, stock office boardroom, bokeh, gradients, or decorative orbs. No text anywhere outside the laptop screen, no headline, no watermarks, no frames, no borders, no collage. Leave the complete left half calm and empty for website content; photograph fills the canvas.

Mobile image-edit prompt, using the generated desktop original as reference:

> Create a responsive mobile hero variant of this original photograph, aspect ratio 2:1 landscape. Preserve the exact photo style, neutral grey stone, graphite laptop, illustrative Valo invoice screen, notebook, pen and olive sprig. Reframe tightly around the COMPLETE laptop, showing its whole screen and whole keyboard without clipping, with some vase on the right and notebook in foreground. Remove almost all of the empty left half; the laptop should occupy about 70 percent of the width, centered. No headline, no extra text, no borders, no extra devices or people. Keep screen data fictitious and no government approvals. Same bright neutral exposure, not sepia or blurry. This is the mobile version of the same photographed workspace, not a webpage mockup.

## Verification

Automated checks use synthetic local fixtures, not real user data or live
enquiry submissions. Browser screenshots and axe reports are ignored under
`artifacts/landing/tmp/accessibility/` and `tmp/platform-refinement/`.

- `pnpm run check`: architecture, secrets, docs, brand, workspace typechecks,
  lint and unit/pure API tests. Two existing hook-dependency warnings remain in
  the unchanged SME invoice-draft helper.
- Landing browser suite: public and login layouts at 320, 390, 768, 1440 and
  1920 px; both audiences and all record views; keyboard focus, mobile menu,
  readiness failure, enquiry failure/retry/concurrency/success and long inputs.
- Additional short-window checks: 320 x 568, 375 x 667, 740 x 731,
  1000 x 800 and 1920 x 800.
- Shared platform browser matrix: Console, SME and Buyer Today views at 320,
  768 and 1360 px in light and dark themes; reflow, focus and control dimensions.
- Existing fixture suites cover activity, Clerk/WHT, filing/branding,
  notification controls, usability and customer recovery.

Completed locally on 8 September 2026: the full quality gate and all five web
builds passed. Public/login browser checks passed 13 tests; the signed-in visual
matrix passed all 18 scenarios; the expanded Clerk/WHT matrix passed 36 scenarios
in both themes, including the floating panel. Activity, recovery, usability,
notification, filing/branding and calculator-loading regressions also passed.
Screenshot review covered landing, auth, all three workspace shells, Clerk and
the dock. Dock screenshots are taken after the opening animation settles, with
an explicit viewport-boundary assertion.

Axe and reflow checks support WCAG 2.2 AA expectations but are not a
conformance certification or a substitute for testing with assistive
technology users. The complete database-backed and production integration
suite must run through CI before publishing this source.

## Local Preview And Release

The localhost-only preview serves the new landing and sign-in bundles. Its
API deliberately returns an unavailable response: login cannot authenticate
and enquiries cannot be delivered from this design preview. This is separate
from production availability. Browser fixtures exercise signed-in views
without real accounts; they are not an authentication bypass in the application.

Production and Replit's staged release are untouched. A subsequent approved
release must use a fresh immutable seven-app CI artifact for the exact merged
source, including its new manifest and sidecar. Locally rebuilt bundles must
not be substituted into the previously staged artifact.
