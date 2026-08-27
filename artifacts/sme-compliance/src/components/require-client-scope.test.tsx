// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const me = { current: {} as Record<string, unknown> };
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: me.current }),
}));

import { RequireClientScope } from "./require-client-scope";

afterEach(cleanup);

describe("RequireClientScope", () => {
  test("unpinned firm principal gets console guidance, not 'sign in with a client account'", () => {
    me.current = { role: "firm_staff", clientPartyId: null };
    render(<RequireClientScope thing="compliance summary">x</RequireClientScope>);
    const card = screen.getByTestId("text-no-client-scope");
    expect(card.textContent).toContain("Open a client from the Accountant Console");
    expect(card.textContent).not.toContain("Sign in with a client account");
    expect(screen.getByTestId("link-open-console").getAttribute("href")).toBe("/console/");
  });
  test("non-firm unscoped account keeps the switch-account instruction, no console link", () => {
    me.current = { role: "buyer_user", clientPartyId: null };
    render(<RequireClientScope thing="compliance summary">x</RequireClientScope>);
    expect(screen.getByTestId("text-no-client-scope").textContent).toContain("Sign in with a client account");
    expect(screen.queryByTestId("link-open-console")).toBeNull();
  });
  test("scoped account renders the page", () => {
    me.current = { role: "client_user", clientPartyId: "abc" };
    render(<RequireClientScope thing="compliance summary">scoped-content</RequireClientScope>);
    expect(screen.queryByTestId("text-no-client-scope")).toBeNull();
    expect(screen.getByText("scoped-content")).toBeDefined();
  });
});
