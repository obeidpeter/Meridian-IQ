import { randomUUID } from "node:crypto";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(
  supplied: string | string[] | undefined,
  generate: () => string = randomUUID,
): string {
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  return typeof candidate === "string" && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : generate();
}
