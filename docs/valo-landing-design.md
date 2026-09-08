# Valo Public Landing Page

## Scope

An editorial redesign of the public landing page only, prepared on
`agent/valo-editorial-landing` from main `60bb3eba3`. No production deployment,
database change, authentication change, or staged-release modification.

The existing React/Vite stack, shared Valo mark, invitation routes, generated
enquiry API client, consent and honeypot fields, aggregate analytics, support
mailbox and public calculator route are retained.

## Design Direction

Quiet order: a full-width original desk photograph, live HTML proposition,
ruled editorial sections, a readable invoice example and distinct accountant
view, followed by one dark evidence section. There are no carousel, animation,
font or application dependencies added.

The reference was [Aesop's official site](https://www.aesop.com/), interpreted
as restraint, material attention and editorial hierarchy. No Aesop asset,
logo, copy or photograph is used.

Tokens are scoped to `.valo-editorial` in
[`landing.css`](../artifacts/landing/src/landing.css). The paper is refined
to a near-white `#f8f8f4`, balanced with a soft botanical-grey outcome band,
charcoal, a stone contact band and semantic blue, amber and green statuses.
This keeps warmth without making the platform a one-colour beige template.

| Token                  | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| Paper                  | #f8f8f4                                               |
| Stone                  | #e9e6dd                                               |
| Primary text           | #2e2c27                                               |
| Secondary text         | #655f54                                               |
| Dividing rule          | #cbc4b6                                               |
| Accent                 | #626a50                                               |
| Evidence background    | #282b25                                               |
| Typography             | Existing Inter; system fallbacks; no new font request |
| Desktop hero           | 60px, medium, fixed breakpoint sizes                  |
| Mobile hero            | 38px; 34px at narrow reflow widths                    |
| Section spacing        | 104px desktop, 80px tablet, 64px mobile               |
| Corners                | 2px                                                   |
| Interaction transition | 180ms; none with reduced motion                       |
| Action targets         | At least 44px; primary buttons 48px                   |

Audience examples share a stable grid track. The inactive example remains
in layout but is visually hidden and excluded from the accessibility tree.
Mobile navigation is an in-flow disclosure, not a modal or overlay; Escape
restores focus to its trigger. Tabs support arrows, Home and End.
The enquiry retains values on error, locks fields during submission, blocks
concurrent submits and focuses the result or reset field after rendering.

## Copy And Availability

Source checks:

- [Release flag catalogue](../artifacts/api-server/src/modules/flags/releases.ts):
  only the R0 invoice, engagement and consent core is enabled by default.
- [Engineering guide](../CLAUDE.md): access boundaries, supported submission,
  retained evidence and bounded Clerk intake with human review.
- [Platform documentation](platform.md) and [Clerk documentation](clerk-ai.md).
- [Existing contact configuration](../lib/format/src/index.ts): the approved
  mailbox remains unchanged.

Extended capabilities are labelled as rolling out or planned, with firm
activation caveats. Internal review is never portrayed as authority approval.
All fictional invoice, client and history data are visibly labelled
**Illustrative example**. No official seal, guarantee, customer statistic,
certification or launch date is invented. Payment evidence does not imply
funds custody or guaranteed payment.

No public privacy or terms destinations were found in the current application.
No dead links or invented legal policies were added; approved public policies
remain a separate owner/legal follow-up.

## Photography

Mode: built-in image generation, new original image; no external image inputs.
The generated original is preserved outside the repository. Sharp was used
only for responsive resizing and format optimisation.

Project assets:

- [Desktop WebP](../artifacts/landing/public/valo-records-hero.webp):
  1942 x 809, 83,138 bytes.
- [Mobile WebP](../artifacts/landing/public/valo-records-mobile.webp):
  800 x 333, 11,274 bytes.
- [Social JPEG](../artifacts/landing/public/valo-records-social.jpg):
  1200 x 630, 75,895 bytes.

Generation prompt:

> Create one original photorealistic editorial photograph for Valo, a Nigerian
> invoicing software brand, as an ultra-wide landscape website hero background
> approximately 2.4:1. Premium architectural editorial photography, thoughtful
> working desk, tactile but modern. Camera 35-degree overhead oblique view.
> A very pale neutral grey limestone work surface fills the image edge to edge,
> subtle natural texture, soft late morning directional window light. Critical
> composition: left 53 percent completely empty pale stone with very even light
> and no objects or strong shadows, reserved for dark HTML headline overlay.
> On the right 47 percent: a neatly aligned stack of two ivory invoice sheets
> with tiny abstract grey document rules but no readable text, one slim dark
> graphite pen parallel to the papers, and upper far right corner a restrained
> cropped silver laptop keyboard and small screen edge. The actual readable
> software interface will be separate HTML; do not draw a dashboard or add any
> readable labels. Paper and pen are the main subject, elegantly arranged not
> scattered. Subtle shadow runs to lower right only. Warm natural light balanced
> with cool neutral stone and black objects, not orange or sepia. Sharp useful
> objects, no blur or vignette. Serious digital business, quiet order. No people,
> plants, skincare, bottles, logos, money, decorative objects, government seals,
> watermarks, text or typography. The photograph itself fills the canvas,
> no frames or borders.

## Verification And Preview

The browser suite lives in
[`accessibility.test.mjs`](../artifacts/landing/e2e/accessibility.test.mjs).
It covers the landing page and unchanged login at 320, 390, 768, 1440 and
1920 px, default and alternative audience views, the mobile menu, readiness
failure, keyboard navigation, enquiry failure/retry/concurrency/success and
long contact details. API responses are intercepted locally; no live user
data or live enquiry submissions are involved.

Generated screenshots and axe reports are ignored under
`artifacts/landing/tmp/accessibility/`. Automated axe and reflow checks
support the WCAG 2.2 AA target; they are not a conformance certification or
a substitute for assistive-technology testing with users.

The localhost-only preview serves the landing, existing login and unchanged
calculator builds. Its API deliberately returns an unavailable response:
login cannot authenticate and enquiries cannot be delivered in this preview.
This is separate from production availability. Browser tests exercise those
UI states using explicit local fixtures. Mail links remain real destinations.

Production integration tests and the immutable seven-app release pipeline must
run when this work is reviewed and approved for release. The current staged
artifact is not reused or changed by this design work.

Completed locally on 8 September 2026:

- `pnpm run check`: passed (two existing hook-dependency warnings in the
  unchanged SME invoice-draft helper).
- Landing production build: passed. The existing label component produces
  a non-blocking sourcemap warning.
- Landing browser matrix: 12 tests passed with no reported accessibility issues.
- Actual localhost calculator and login destinations checked; the direct
  accountant anchor selects the correct view.
- Screenshot inspection: desktop, tablet, mobile, navigation and product states.

The full DB-backed and production integration suite was not run for this
public-page-only preview.
