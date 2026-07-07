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
  UNKNOWN: {
    code: "UNKNOWN",
    cause: "An unclassified error occurred.",
    fix: "Escalated to the operator queue with full context.",
    retriable: true,
  },
};

export function lookupError(code: string): CatalogueEntry {
  return ERROR_CATALOGUE[code] ?? ERROR_CATALOGUE.UNKNOWN;
}

export function isRetriable(code: string): boolean {
  return lookupError(code).retriable;
}

// Thrown by domain services; carries a catalogue code and HTTP status.
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
