// Normalized error catalogue (INT-02, ADV-03). Every rail rejection and every
// domain failure maps to a stable catalogue code with a plain-language cause and
// fix. Operators can extend the catalogue without engineering (persisted rows in
// a later iteration); the seed set below covers the MBS/APP rejections we know.

export interface CatalogueEntry {
  code: string;
  cause: string;
  fix: string;
  retriable: boolean;
}

export const ERROR_CATALOGUE: Record<string, CatalogueEntry> = {
  MBS_INVALID_TIN: {
    code: "MBS_INVALID_TIN",
    cause: "The supplier or buyer TIN was rejected by the tax authority.",
    fix: "Verify the TIN against the registry and re-submit once validated.",
    retriable: false,
  },
  MBS_SCHEMA_INVALID: {
    code: "MBS_SCHEMA_INVALID",
    cause: "The invoice failed UBL / BIS Billing 3.0 structural validation.",
    fix: "Correct the flagged mandatory field and re-submit.",
    retriable: false,
  },
  MBS_DUPLICATE: {
    code: "MBS_DUPLICATE",
    cause: "An invoice with the same reference was already stamped.",
    fix: "Use the existing stamp; do not re-submit the same invoice number.",
    retriable: false,
  },
  RAIL_TIMEOUT: {
    code: "RAIL_TIMEOUT",
    cause: "The access-point rail did not respond in time.",
    fix: "Automatically retried on the alternate rail with backoff.",
    retriable: true,
  },
  RAIL_UNAVAILABLE: {
    code: "RAIL_UNAVAILABLE",
    cause: "The access-point rail is currently unavailable (circuit open).",
    fix: "Automatically failed over to the alternate rail.",
    retriable: true,
  },
  RAIL_RATE_LIMITED: {
    code: "RAIL_RATE_LIMITED",
    cause: "The rail rejected the request due to rate limiting.",
    fix: "Retried with exponential backoff.",
    retriable: true,
  },
  // R95: the two outcomes only a real transport can produce. Both retriable on
  // purpose — a refused credential or an unreadable answer is the PLATFORM's
  // failure, not the invoice's, so the invoice stays `submitted`, the breaker
  // opens, one health alert fires, and the backlog drains once it is fixed
  // (a protocol retry that meets MBS_DUPLICATE recovers the stamp the rail
  // already issued).
  RAIL_UNAUTHORIZED: {
    code: "RAIL_UNAUTHORIZED",
    cause: "The access-point rail refused this deployment's credentials.",
    fix: "Fix RAIL_PRIMARY_TOKEN / RAIL_SECONDARY_TOKEN; submissions wait on the breaker and resume.",
    retriable: true,
  },
  RAIL_PROTOCOL: {
    code: "RAIL_PROTOCOL",
    cause:
      "The access-point rail answered in a shape this build does not understand.",
    fix: "Retried; if the rail had already stamped the invoice, the duplicate path recovers the stamp it holds.",
    retriable: true,
  },
  UNKNOWN: {
    code: "UNKNOWN",
    cause: "An unclassified error occurred.",
    fix: "Escalated to the operator queue with full context.",
    retriable: true,
  },
};

function lookupError(code: string): CatalogueEntry {
  return ERROR_CATALOGUE[code] ?? ERROR_CATALOGUE.UNKNOWN;
}

export function isRetriable(code: string): boolean {
  return lookupError(code).retriable;
}

// Thrown by domain services; carries a catalogue code and HTTP status.
// Plain field assignments (not TS parameter properties) so the module runs
// under node --test's strip-only type stripping.
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}
