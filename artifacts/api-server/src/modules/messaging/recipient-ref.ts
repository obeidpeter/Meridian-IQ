// Opaque, PII-free recipient reference derived from a party id: letters only,
// so it never trips the messaging data-boundary check (SEC-12), and stable per
// party so sends can be correlated without exposing the id itself. Every
// notification channel (messaging, push, reminders, B2C alerts) must build its
// recipientRef through this one helper — a drifted copy would silently break
// that correlation. CORRELATION ONLY: the derivation is lossy (uuid letters
// alone), so refs can collide across parties — the ledger's real recipient
// identity is the recipient_user_id / recipient_party_id columns the send
// rails stamp alongside the ref (see modules/messaging/inbox.ts), never the
// ref itself.
export function recipientRefFor(clientPartyId: string): string {
  const letters = clientPartyId.replace(/[^a-z]/gi, "").slice(0, 16);
  return `ref-${letters || "client"}`;
}

// Pointer-only entity reference (SEC-12): letters from the entity id only, no
// digits, truncated to 6 — the same shape on every channel so sends correlate
// without exposing the id, and short enough that assertPointerOnly's digit
// check can never trip. Correlation/display only (~15.5 bits when used as a
// usr- recipient ref — nowhere near unique); the identity columns above are
// what feeds resolve by. NOTE: deliberately no fallback token (unlike
// recipientRefFor) — an all-letter-free id yields just `${prefix}-`, matching
// the historical output of both sweeps.
export function pointerEntityRef(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-z]/gi, "").slice(0, 6)}`;
}
