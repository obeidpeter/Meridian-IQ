import assert from "node:assert/strict";
import { DomainError } from "../modules/errors.ts";

// Shared DomainError assertion helpers for test files.

export function expectDomainError(err: unknown, code: string, status: number): void {
  assert.ok(err instanceof DomainError, `expected DomainError, got ${err}`);
  assert.equal(err.code, code);
  assert.equal(err.status, status);
}

// Predicate form for assert.rejects: matches a DomainError by code, and by
// status too when one is given.
export function isDomainError(code: string, status?: number) {
  return (e: unknown): boolean =>
    e instanceof DomainError &&
    e.code === code &&
    (status === undefined || e.status === status);
}
