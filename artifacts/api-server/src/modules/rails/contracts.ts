import type { Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../invoice/canonical";

export interface StampResult {
  status: "accepted" | "rejected" | "error";
  rail: Rail;
  irn?: string;
  csid?: string;
  qrPayload?: string;
  signedArtifactRef?: string;
  errorCode?: string;
  raw: Record<string, unknown>;
  provider?: string;
  environment?: string;
}

/**
 * The rail seam (R97). Pipeline and recovery code depend on this contract;
 * simulator, HTTP, and scripted implementations depend on it independently.
 * `lookup` answers whether a rail already issued a stamp for an idempotency key.
 */
export interface RailTransport {
  readonly name: string;
  readonly environment: string;
  readonly rails?: readonly Rail[];
  submit(
    rail: Rail,
    invoice: CanonicalInvoice,
    idempotencyKey: string,
  ): Promise<StampResult>;
  lookup(
    rail: Rail,
    invoice: CanonicalInvoice,
    idempotencyKey: string,
  ): Promise<StampResult | null>;
}
