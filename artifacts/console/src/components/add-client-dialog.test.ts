import { test, expect, describe } from "vitest";
import {
  CLIENT_ADDED_TOAST,
  buildCreateClientInput,
  createClientErrorNote,
} from "./add-client-dialog";

// The single-client intake dialog: input shaping (the server rejects blank
// optionals sent as empty strings) and the duplicate-guard wording.

describe("buildCreateClientInput", () => {
  test("trims every field and keeps only what was provided", () => {
    expect(
      buildCreateClientInput({
        legalName: "  Acme Trading Ltd  ",
        tin: " 12345678-0001 ",
        cacNumber: " RC123456 ",
        street: " 1 Broad St ",
        city: " Lagos ",
      }),
    ).toEqual({
      legalName: "Acme Trading Ltd",
      tin: "12345678-0001",
      cacNumber: "RC123456",
      street: "1 Broad St",
      city: "Lagos",
    });
  });

  test("blank optionals are OMITTED — never sent as empty strings", () => {
    const data = buildCreateClientInput({
      legalName: "Acme Trading Ltd",
      tin: "",
      cacNumber: "   ",
      street: "",
      city: "",
    });
    expect(data).toEqual({ legalName: "Acme Trading Ltd" });
    expect("tin" in data).toBe(false);
    expect("cacNumber" in data).toBe(false);
    expect("street" in data).toBe(false);
    expect("city" in data).toBe(false);
  });
});

describe("createClientErrorNote", () => {
  test("a 409 is the duplicate guard, in the dialog's words", () => {
    expect(createClientErrorNote({ status: 409 })).toBe(
      "You already have a client with this TIN/name.",
    );
  });

  test("a 400 relays the server's own words (e.g. a malformed TIN)", () => {
    expect(
      createClientErrorNote({
        status: 400,
        data: { error: "TIN must be 8 digits + -0001" },
      }),
    ).toBe("TIN must be 8 digits + -0001");
  });

  test("a wordless failure falls back to the plain try-again line", () => {
    expect(createClientErrorNote(new Error("network"))).toBe(
      "Could not add the client. Try again.",
    );
  });
});

describe("CLIENT_ADDED_TOAST", () => {
  test("the success toast points at the next checklist step", () => {
    expect(CLIENT_ADDED_TOAST).toBe("Client added — invite their owner next.");
  });
});
