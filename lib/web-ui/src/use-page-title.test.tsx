// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { usePageTitle } from "./use-page-title";

// RTL's auto-cleanup needs framework globals, which stay off here.
afterEach(cleanup);

function Harness({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

describe("usePageTitle", () => {
  test("sets the branded title and restores the default on unmount", () => {
    const { rerender, unmount } = render(<Harness title="Invoices" />);
    expect(document.title).toBe("Invoices · MeridianIQ");

    rerender(<Harness title="Settings" />);
    expect(document.title).toBe("Settings · MeridianIQ");

    unmount();
    expect(document.title).toBe("MeridianIQ");
  });
});
