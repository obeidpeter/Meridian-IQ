interface EvidenceErrorCopy {
  code: string;
  status: number;
  message: string;
  legacy: readonly string[];
}

const pdfSafetyMessage =
  "This PDF could not be inspected safely. Choose an unencrypted, flattened PDF of at most 100 pages and try again.";
const pdfSafetyLegacy = [
  "This PDF could not be inspected within its safety limits. Use an unencrypted, flattened PDF of at most 100 pages.",
];

// Exact legacy matches support the current { error: string } response without
// ever displaying arbitrary server text. Prefer a structured code when present.
const evidenceErrors: readonly EvidenceErrorCopy[] = [
  {
    code: "EVIDENCE_STORAGE_FULL",
    status: 409,
    message:
      "This workspace has reached its document storage limit. Contact support before uploading again.",
    legacy: [
      "This workspace has reached its document storage limit. Contact support.",
    ],
  },
  {
    code: "EVIDENCE_VERSION_LIMIT",
    status: 409,
    message:
      "This request has reached its document version limit. Ask your accounting team to create a new request.",
    legacy: [
      "This request has reached its 20-version limit. Ask your accountant to create a new request.",
    ],
  },
  {
    code: "EVIDENCE_REQUEST_LIMIT",
    status: 409,
    message:
      "This workspace has reached its evidence request limit. Contact support before creating another request.",
    legacy: [
      "This workspace has reached its evidence-request limit. Contact support.",
    ],
  },
  {
    code: "EVIDENCE_CLOSED",
    status: 409,
    message:
      "This request is closed. Ask your accounting team to request changes on an accepted request, or create a new request if it was cancelled.",
    legacy: [
      "This request has been cancelled. Create a new request if needed.",
      "This request is closed. Request changes before changing its assignment.",
      "This request is closed. Ask your accountant to request changes before uploading again.",
    ],
  },
  {
    code: "EVIDENCE_VERSION_CONFLICT",
    status: 409,
    message:
      "Someone changed this request. Refresh it and check the latest details before trying again.",
    legacy: ["Someone changed this request. Refresh it before continuing."],
  },
  {
    code: "EVIDENCE_REQUEST_REUSED",
    status: 409,
    message:
      "This attempt was already used for different content. Refresh the request and start a new attempt.",
    legacy: [
      "This action was already used for different content. Refresh and try again.",
    ],
  },
  {
    code: "EVIDENCE_FILE_CHANGED",
    status: 409,
    message:
      "The selected document is no longer the latest version. Refresh the request and review the latest document.",
    legacy: [
      "Review the latest document before continuing.",
      "Review the latest uploaded document before accepting it.",
    ],
  },
  {
    code: "EVIDENCE_QUARANTINED",
    status: 409,
    message:
      "This document has not passed its security scan. Wait for a clean result before opening or accepting it.",
    legacy: [
      "This document has not passed its security scan and cannot be opened.",
      "The document must pass its security scan before it can be accepted.",
    ],
  },
  {
    code: "EVIDENCE_FILE_NOT_CLEAN",
    status: 409,
    message:
      "This document has not passed its security scan. Wait for a clean result before running assistance.",
    legacy: ["Only clean evidence files can be read"],
  },
  {
    code: "EVIDENCE_ALREADY_SCANNED",
    status: 409,
    message:
      "This document has already passed its security scan. Refresh the request to see its current status.",
    legacy: ["This document has already passed its security scan."],
  },
  {
    code: "EVIDENCE_SCAN_IN_PROGRESS",
    status: 409,
    message:
      "This document is queued for scanning or is being scanned. Wait a moment, then refresh its status.",
    legacy: [
      "This document is already being scanned. Check again shortly.",
      "This document is already waiting for a security scan.",
    ],
  },
  {
    code: "EVIDENCE_SCAN_UNAVAILABLE",
    status: 503,
    message:
      "The security scanner is unavailable. Contact your workspace administrator; the document remains quarantined.",
    legacy: [
      "The security scanner is not configured. Contact your administrator.",
    ],
  },
  {
    code: "EVIDENCE_STORAGE_UNAVAILABLE",
    status: 503,
    message:
      "Secure document storage is unavailable. Contact your workspace administrator before trying again.",
    legacy: [
      "Secure document storage is not configured. Contact your administrator.",
    ],
  },
  {
    code: "EVIDENCE_INTEGRITY_FAILED",
    status: 503,
    message:
      "This document could not be read safely. Contact support before trying to use it again.",
    legacy: ["This document could not be read safely. Contact support."],
  },
  {
    code: "EVIDENCE_INTEGRITY",
    status: 409,
    message:
      "This document could not be read safely. Contact support before trying to use it again.",
    legacy: ["Evidence file integrity check failed"],
  },
  {
    code: "EVIDENCE_CHANGED",
    status: 409,
    message:
      "The evidence changed while checks were running. Refresh the request and run the checks again.",
    legacy: [
      "Evidence request changed; run the checks again",
      "Evidence file changed; run the checks again",
    ],
  },
  {
    code: "EVIDENCE_PACK_CHANGED",
    status: 409,
    message:
      "This evidence pack is not ready or its records changed. Refresh the request and confirm a clean document is accepted before exporting again. Contact support if it remains unavailable.",
    legacy: [
      "The request must still accept the pinned evidence file",
      "Evidence history does not belong to this request",
      "Evidence history has inconsistent file versions",
      "The accepted file version changed during export",
      "An accepted human review for the pinned file is required",
      "Unexpected invoice in a non-invoice evidence pack",
      "The invoice anchor is unavailable",
      "Invoice source does not belong to this request",
      "Invoice PDF and stamp metadata must use the same stamp record",
      "Accept a clean evidence file before exporting a pack",
      "Evidence or its invoice changed during export; request a fresh pack",
    ],
  },
  {
    code: "EVIDENCE_PACK_TOO_LARGE",
    status: 413,
    message:
      "This evidence pack exceeds the export limit. Download clean documents individually or contact support.",
    legacy: [
      "Evidence packs must be under 25 MB with at most 50 files and 2000 history events",
    ],
  },
  {
    code: "EVIDENCE_WORK_CONFLICT",
    status: 409,
    message:
      "This request conflicts with an existing work item. Refresh the request; contact support if the conflict remains.",
    legacy: ["Document request conflicts with an existing work item"],
  },
  {
    code: "EVIDENCE_OWNER_INVALID",
    status: 400,
    message: "Choose a workspace owner with access to this client.",
    legacy: ["Choose an owner who can access this client."],
  },
  {
    code: "EVIDENCE_COMMENT_REQUIRED",
    status: 400,
    message: "Add an explanation for the requested changes or cancellation.",
    legacy: [
      "Explain what needs to change or why this request is being cancelled.",
    ],
  },
  {
    code: "EVIDENCE_ACTIVE_CONTENT",
    status: 400,
    message:
      "Choose an unencrypted, flattened PDF of at most 100 pages without scripts, active actions or embedded attachments.",
    legacy: [
      "Use a flattened PDF without scripts or embedded attachments.",
      "Use a flattened PDF without scripts, active actions or embedded attachments.",
    ],
  },
  {
    code: "EVIDENCE_PDF_BUSY",
    status: 503,
    message:
      "Document inspection is busy. Wait a moment, then retry the same upload.",
    legacy: ["Document inspection is busy. Try the upload again shortly."],
  },
  {
    code: "EVIDENCE_PDF_LIMIT",
    status: 422,
    message: pdfSafetyMessage,
    legacy: pdfSafetyLegacy,
  },
  {
    code: "EVIDENCE_PDF_TIMEOUT",
    status: 422,
    message: pdfSafetyMessage,
    legacy: pdfSafetyLegacy,
  },
  {
    code: "EVIDENCE_PDF_UNREADABLE",
    status: 422,
    message: pdfSafetyMessage,
    legacy: pdfSafetyLegacy,
  },
  {
    code: "EVIDENCE_FILENAME_INVALID",
    status: 400,
    message:
      "Rename the document without slashes or control characters, then select it again.",
    legacy: ["Use a filename without slashes or control characters."],
  },
  {
    code: "EVIDENCE_TYPE_INVALID",
    status: 400,
    message:
      "Choose a valid JPEG, PNG or PDF whose filename matches its document type.",
    legacy: ["Choose a valid PDF, PNG or JPEG with a matching filename."],
  },
];

export function knownEvidenceError(error: unknown, status: number | undefined) {
  if (!error || typeof error !== "object" || !("data" in error)) return;
  const data = error.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const code = "code" in data ? data.code : undefined;
  const message = "error" in data ? data.error : undefined;
  const match = evidenceErrors.find((entry) => {
    if (entry.status !== status) return false;
    if (code !== undefined) return entry.code === code;
    return typeof message === "string" && entry.legacy.includes(message);
  });
  return match?.message;
}
