import { describe, expect, test } from "vitest";
import {
  defaultWorkspaceFor,
  resolveReturnTo,
  sanitizeReturnTo,
} from "./return-to";

const APPS = [
  {
    name: "Bank Data Room",
    href: "/console/data-room",
    allowedRoles: ["bank_user"],
  },
  {
    name: "Compliance App",
    href: "/app/",
    allowedRoles: ["firm_admin", "firm_staff", "client_user"],
  },
  {
    name: "Accountant Console",
    href: "/console/",
    allowedRoles: ["firm_admin", "firm_staff", "operator", "auditor"],
  },
  { name: "Buyer Rails", href: "/buyer/", allowedRoles: ["buyer_user"] },
  {
    name: "Penalty Calculator",
    href: "/penalty-calculator/",
    allowedRoles: null,
  },
];

describe("sanitizeReturnTo", () => {
  test("accepts a same-origin relative path with a query", () => {
    expect(sanitizeReturnTo("/app/invoices/abc?tab=history")).toBe(
      "/app/invoices/abc?tab=history",
    );
  });
  test("rejects absolute, protocol-relative, backslash and schemeless forms", () => {
    expect(sanitizeReturnTo("https://evil.example/app/")).toBeNull();
    expect(sanitizeReturnTo("//evil.example/app/")).toBeNull();
    expect(sanitizeReturnTo("/\\evil.example")).toBeNull();
    expect(sanitizeReturnTo("app/")).toBeNull();
    expect(sanitizeReturnTo(null)).toBeNull();
  });
});

describe("resolveReturnTo", () => {
  test("returns the deep path labelled by its workspace", () => {
    expect(resolveReturnTo("/app/invoices/abc", "client_user", APPS)).toEqual({
      href: "/app/invoices/abc",
      label: "Compliance App",
    });
  });
  test("honours the workspace a firm_admin picked over the role default", () => {
    expect(resolveReturnTo("/app/", "firm_admin", APPS)).toEqual({
      href: "/app/",
      label: "Compliance App",
    });
  });
  test("rejects a workspace the role cannot open", () => {
    expect(resolveReturnTo("/console/", "buyer_user", APPS)).toBeNull();
    expect(resolveReturnTo("/buyer/", "client_user", APPS)).toBeNull();
    expect(
      resolveReturnTo("/console/data-room", "firm_admin", APPS),
    ).toBeNull();
  });
  test("allows only a bank user to resume the private data room", () => {
    expect(resolveReturnTo("/console/data-room", "bank_user", APPS)).toEqual({
      href: "/console/data-room",
      label: "Bank Data Room",
    });
  });
  test("never matches the public tile or lookalike prefixes", () => {
    expect(
      resolveReturnTo("/penalty-calculator/", "client_user", APPS),
    ).toBeNull();
    expect(resolveReturnTo("/application/x", "client_user", APPS)).toBeNull();
  });
});

describe("defaultWorkspaceFor", () => {
  test("routes client-pinned firm staff to the Compliance App", () => {
    expect(
      defaultWorkspaceFor({
        role: "firm_staff",
        clientPartyId: "22222222-2222-4222-8222-222222222222",
      })?.href,
    ).toBe("/app/");
  });
  test("routes unpinned firm staff to the console", () => {
    expect(
      defaultWorkspaceFor({ role: "firm_staff", clientPartyId: null })?.href,
    ).toBe("/console/");
  });
  test("keeps the operator on the work queue", () => {
    expect(defaultWorkspaceFor({ role: "operator" })?.href).toBe(
      "/console/operator-queue",
    );
  });
  test("routes a bank reviewer directly to the Data Room", () => {
    expect(defaultWorkspaceFor({ role: "bank_user" })?.href).toBe(
      "/console/data-room",
    );
  });
});
