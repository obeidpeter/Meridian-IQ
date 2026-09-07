import type { Request } from "express";
import { DomainError } from "../modules/errors";

/** Accept old clients during the rebrand without ambiguous workspace selection. */
export function brandHeader(
  req: Pick<Request, "get">,
  name: "csrf" | "workspace" | "client",
): string | undefined {
  const current = req.get(`x-valo-${name}`);
  const legacy = req.get(`x-meridian-${name}`);
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new DomainError("BAD_REQUEST", "Conflicting client headers");
  }
  return current ?? legacy;
}
