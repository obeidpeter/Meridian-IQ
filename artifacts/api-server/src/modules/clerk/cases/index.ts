// Clerk capture cases (Task #40, C1). The Clerk PROPOSES, the operator
// DISPOSES: extraction output is candidate values only; nothing reaches the
// invoice spine until a named operator confirms every critical field and
// approves — and even then only a DRAFT invoice is created. There is no code
// path from this module to invoice submission.
//
// Split by concern (the routes/invoices + data-intents pattern) — each slice
// is a contiguous section of the old single-file cases.ts:
//   documents.ts   upload decode/extract/rasterize plumbing + the
//                  fence/user-content builders and lane-dispatch registries
//   extraction.ts  the model-calling extraction runners (both gateway.infer
//                  calls) and output normalization
//   lifecycle.ts   intake/retry, listing/detail, source pages, feedback,
//                  claim/release
//   decisions.ts   operator decisions (invoice approve → DRAFT invoice;
//                  notice approve → open obligation)
// This index re-exports the module's public surface ONLY. Cross-slice
// internals (the content-builder registries, runExtraction /
// runNoticeExtraction, assertPartyInFirm) stay invisible outside
// modules/clerk/cases/.

export {
  MAX_SCAN_PAGES,
  decodeBase64Checked,
  extractPdfText,
  fenceDocument,
  rasterizePdfScan,
  resolveTextSource,
  scanUserContent,
} from "./documents";
export { normalizeExtraction, normalizeNoticeExtraction } from "./extraction";
export {
  caseSourcePages,
  claimCase,
  createExtractionCase,
  creatorClientParty,
  getCase,
  listCases,
  releaseCase,
  retryExtraction,
  setCaseFeedback,
  type CaseContext,
  type CreateCaseInput,
} from "./lifecycle";
export {
  decideCase,
  decideNoticeCase,
  type CaseDecisionInput,
  type NoticeDecisionInput,
} from "./decisions";
