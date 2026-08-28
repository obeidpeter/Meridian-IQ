# Cognitive walkthrough — the two first-run flows (2026-08, R67)

## Method

Cognitive walkthrough in the three-question form (Wharton et al., as taught in
Sharp/Preece/Rogers): for every step of a defined task, an evaluator asks

1. **Will the user know what to do?** (is the right action their plausible goal)
2. **Will they see how to do it?** (is the control visible and recognisable)
3. **Will they understand the feedback?** (does the response confirm progress)

This complements the R64 heuristic audit (`findings-register.json`): the
heuristic pass inspected surfaces; this pass followed two complete first-run
tasks through the real production builds (api-server dist + built bundles,
served the way `scripts/src/e2e/run.mjs` serves them) against a fresh seeded
database. Every step was actually performed and screenshotted; the driver and
screens live in the session workspace (not committed — this record is the
artifact).

**Honesty box.** This is an expert walkthrough, not user testing: one evaluator
simulating a first-time user, which finds action-visibility and feedback
breaks but cannot find vocabulary or mental-model surprises real users would
hit. The invited client user joins the *seeded* Adaeze Foods party, so their
"first run" lands in a workspace that already has invoices; a true
empty-workspace first run (brand-new client party with no paper) remains
unwalked — it needs the operator "Add client" path and is noted in the
backlog. The R64 human-testing protocol is still the instrument for real
participants.

## Flow B — firm admin invites a client's first user

Steps: sign in → find the invitation surface → issue a `client_user` invite
scoped to a client → hand over the link.

| Step | Q1 know? | Q2 see? | Q3 feedback? | Notes |
|---|---|---|---|---|
| B1 sign-in | pass | pass | pass | R65 plain-language portal. |
| B2 find the surface | **partial** | pass | — | See finding W-1. |
| B3 fill the invite form | pass | pass | pass | Header states the contract: "you share the link yourself; pending invites can be revoked". Role defaults to Firm staff; switching to Client user reveals the client picker with a plain hint ("Pick the client this login is scoped to"). |
| B4 issue + hand over | pass | pass | pass | One-time-token card: "This link is shown once — copy it now", copy button, expiry line, invite listed as Pending below. Strong step. |

**W-1 (medium, launch-active).** The goal "get my client into MeridianIQ" has
three plausible first clicks on the portfolio screen: **Onboarding** (nav,
higher than Team invitations), **+ Add client** (header CTA), and **Team
invitations** (nav, under an employee-sounding name). The correct action for
inviting a *user* is Team invitations, whose label reads as
teammates-only — the description on the page does say "teammate or client",
but the user must already be on the page to read it. Recommendation
(deferred): either rename the nav entry (e.g. "Invitations") or add an
"Invite someone" action to the client-detail/portfolio surface where the
operator is already looking at the client. Recorded in
`backlog-deferred.json`.

## Flow A — the invited client user's first run → first stamped invoice

Steps: open the accept link → activate → sign in → orient → create the first
invoice → submit → understand the outcome.

| Step | Q1 know? | Q2 see? | Q3 feedback? | Notes |
|---|---|---|---|---|
| A1 accept link | pass | pass | pass | Focused "Activate your account" card, password rule stated inline, mismatch called out on the field. Low finding W-4: the card names neither the invited email nor the workspace being joined — the invitee cannot confirm they are activating the right identity before setting a password. |
| A2 activate → sign in | pass | pass | pass | Success card says exactly what happens next ("Your password is set. Sign in to open your workspace."). Re-entering the just-set password is mild friction accepted for session hygiene. |
| A3 orient on first landing | pass | **partial** | pass | The dashboard leads with a prioritized, plain-language "What needs attention" list and a prominent **New invoice** CTA — the first-task path is unmissable. But see W-2: the nav's Workspace group (Calendar, Analytics, Notifications, Alert settings, Consent, **Help**) sits below an invisible scroll fold at a common 900px-high viewport. |
| A4 create the first invoice | pass | pass | pass | Form explains itself: "We check it against FIRS rules as you type", live compliance checklist, invoice number prefilled with the next number in sequence, NGN + 7.5% VAT defaults, WHT explained in one sentence. The buyer list is correctly scoped (SEC-03) and populated. |
| A5 understand the draft | pass | pass | pass | "Invoice created — saved to your vault" toast; Draft badge; amber status card with one recommended action; "What does stamping mean?" help link (R66) exactly where the new vocabulary appears. |
| A6 submit for stamping | pass | pass | **fail → fixed** | See W-3. |
| A7 comprehend the outcome | pass | pass | pass | Stamped badge, green status card ("Stamped by the tax authority", IRN quoted, "No action needed"), FIRS card expanding IRN/CSID acronyms, submission timeline showing the accepted attempt. The stamp actually landed rail-side during the walkthrough. |

**W-2 (medium, launch-active).** At 1360×900 the SME nav scrolls, the thin
scrollbar on the dark rail is easy to miss, and nothing else hints that more
navigation exists — so Calendar, Consent, Alert settings and **Help** are
effectively invisible to a first-run user, the exact audience Help was built
for (R66). Ctrl+K mitigates but is itself a discovered feature. Deferred with
recommendations (scroll cue or pinning Help to the always-visible footer
region) in `backlog-deferred.json`.

**W-3 (high, launch-active) — found and fixed this round.** The instant after
"Submit for stamping", the page said two opposite things at once: the badge
flipped to *Awaiting stamp* and the toast said *Submitted for stamping*, while
the Compliance-status card still read *"Amber — Invoice has not been submitted
yet. Recommended action: review the draft and submit it."* Root cause:
`refreshInvoiceState()` in `invoice-detail.tsx` invalidated the invoice and
attempt queries but not the status-light query, and the status light also
never polled while the invoice resolved rail-side — so the contradiction
persisted until a full remount. Fixed in R67: the status-light query is now
invalidated with its siblings and polls on the same 15s rhythm as the invoice
while status is `submitted`.

**W-4 (low, launch-active).** Accept page names neither the invitee email nor
the joined workspace (see A1). Deferred.

## Verdict

Both first-run flows complete without a dead end, and the R65/R66 work shows
exactly where it should: plain-language explanations appear at the moment new
vocabulary is introduced, and every screen states its next action. The
walkthrough still earned its keep — W-3 was a real feedback contradiction at
the single most anxious moment of the product (handing paper to the tax
authority), invisible to heuristics-by-inspection and to the e2e suite (which
asserts elements, not their mutual consistency), and is fixed. W-1/W-2/W-4
are deferred with recommendations.
