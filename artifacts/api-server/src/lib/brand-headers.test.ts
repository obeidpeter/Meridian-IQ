import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { brandHeader } from "./brand-headers";

function request(headers: Record<string, string>): Pick<Request, "get"> {
  return { get: ((name: string) => headers[name.toLowerCase()]) as Request["get"] };
}

for (const suffix of ["csrf", "workspace", "client"] as const) {
  test(`${suffix}: accepts Valo, historical, and matching dual headers`, () => {
    const value = suffix === "csrf" ? "1" : suffix === "client" ? "mobile" : "buyer";
    assert.equal(brandHeader(request({ [`x-valo-${suffix}`]: value }), suffix), value);
    assert.equal(brandHeader(request({ [`x-meridian-${suffix}`]: value }), suffix), value);
    assert.equal(brandHeader(request({ [`x-valo-${suffix}`]: value, [`x-meridian-${suffix}`]: value }), suffix), value);
    assert.equal(brandHeader(request({}), suffix), undefined);
  });
  test(`${suffix}: conflicting aliases fail closed`, () => {
    assert.throws(() => brandHeader(request({ [`x-valo-${suffix}`]: "buyer", [`x-meridian-${suffix}`]: "other" }), suffix), /Conflicting client headers/);
  });
}
