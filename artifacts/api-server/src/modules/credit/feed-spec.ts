// OPEN-4 collection-account feed profile. This is an operator-visible
// specification of the existing signed inbound rail, not a second webhook.
// Keeping the profile executable data lets docs, API and tests share one
// version while bank-specific transport onboarding stays outside source code.
export const COLLECTION_ACCOUNT_FEED_SPECIFICATION = Object.freeze({
  version: "miq-collection-feed-1.0.0",
  status: "ready_for_bank_agreement" as const,
  transport: "HTTPS POST",
  path: "/api/collections/inbound",
  acknowledgementStatus: 202,
  semantics: "at_least_once" as const,
  authentication: {
    scheme: "HMAC-SHA256",
    keyRingEnvironment: "COLLECTION_WEBHOOK_KEYS",
    signedComponents: ["timestamp", "method", "path", "body_sha256"],
    replayWindowSeconds: 300,
    legacyTokensAllowedInProduction: false,
  },
  payload: [
    {
      name: "accountReference",
      type: "string",
      required: true,
      maxLength: 256,
    },
    { name: "amount", type: "decimal_string", required: true, maxLength: 32 },
    { name: "invoiceNumber", type: "string", required: true, maxLength: 256 },
    { name: "reference", type: "string", required: true, maxLength: 200 },
    { name: "paidAt", type: "iso_date_time", required: false, maxLength: null },
  ],
  idempotency: {
    source: "provider_reference",
    behavior: "duplicate acknowledgements do not duplicate settlement events",
  },
  privacy: {
    unknownAccountsIndistinguishable: true,
    responseContainsInvoiceData: false,
    logsContainRawPayload: false,
  },
});
