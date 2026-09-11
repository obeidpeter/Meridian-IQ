// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const harness = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  isLoading: false,
  missing: false,
  error: null as { status: number } | null,
  theme: {} as Record<string, unknown>,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { firmId: "firm-1" } }),
    useGetFirm: () => ({
      data: harness.missing
        ? undefined
        : {
            id: "firm-1",
            name: "Meridian Advisory",
            subdomain: "meridian-advisory",
            theme: harness.theme,
          },
      isLoading: harness.isLoading,
      error: harness.error,
      refetch: harness.refetch,
    }),
    useUpdateFirmTheme: () => ({ mutate: harness.mutate, isPending: false }),
  };
});

import { WhiteLabel } from "./whitelabel";

let client: QueryClient;
beforeEach(() => {
  harness.mutate.mockClear();
  harness.refetch.mockClear();
  Object.assign(harness, {
    isLoading: false,
    missing: false,
    error: null,
    theme: {},
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function renderPage() {
  render(
    <QueryClientProvider client={client}>
      <WhiteLabel />
    </QueryClientProvider>,
  );
}

test.each(["Evergreen", "Atlantic", "Cobalt", "Burgundy", "Graphite"])(
  "%s preview keeps text opaque and darkens highlights without saving the theme",
  (preset) => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: preset }));
    const header = screen.getByTestId("preview-header");
    expect(header.style.color).toBe("rgb(255, 255, 255)");
    const initials = within(header).getByText("MA");
    const selected = within(header).getByText("Dashboard");
    for (const element of [initials, selected]) {
      expect(element.style.backgroundColor).toBe("rgba(0, 0, 0, 0.15)");
      expect(element.className).not.toMatch(/bg-white\//);
    }
    for (const label of ["Invoices", "Filings", "Collections"]) {
      expect(within(header).getByText(label).className).not.toMatch(/opacity-/);
    }
    expect(screen.getByTestId("preview-button").style.color).toBe(
      header.style.color,
    );
    expect(harness.mutate).not.toHaveBeenCalled();
  },
);

test.each(["0 0% 100%", "60 100% 50%", "0 0% 50%", "0 0% 46.666667%"])(
  "custom light colour %s uses black text and a lighter highlight in both preview modes",
  (primary) => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Primary colour (HSL)"), {
      target: { value: primary },
    });
    for (const mode of ["Desktop", "Mobile"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      const header = screen.getByTestId("preview-header");
      expect(header.style.color).toBe("rgb(0, 0, 0)");
      expect(within(header).getByText("MA").style.backgroundColor).toBe(
        "rgba(255, 255, 255, 0.2)",
      );
      expect(screen.getByTestId("preview-button").style.color).toBe(
        header.style.color,
      );
      expect(screen.getByText("Increase colour contrast")).toBeTruthy();
    }
    expect(harness.mutate).not.toHaveBeenCalled();
  },
);

test.each(["0 0% 0%", "240 100% 10%"])(
  "custom dark colour %s retains white preview text",
  (primary) => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Primary colour (HSL)"), {
      target: { value: primary },
    });
    expect(screen.getByTestId("preview-header").style.color).toBe(
      "rgb(255, 255, 255)",
    );
    expect(screen.getByTestId("preview-button").style.color).toBe(
      "rgb(255, 255, 255)",
    );
    expect(harness.mutate).not.toHaveBeenCalled();
  },
);

test("invalid colour keeps a readable fallback preview and cannot be published", () => {
  renderPage();
  fireEvent.change(screen.getByLabelText("Primary colour (HSL)"), {
    target: { value: "not a colour" },
  });
  expect(screen.getByTestId("preview-header").style.color).toBe(
    "rgb(255, 255, 255)",
  );
  expect(
    screen.getByTestId("button-save-branding").hasAttribute("disabled"),
  ).toBe(true);
  expect(harness.mutate).not.toHaveBeenCalled();
});

test("a stored wrapped HSL theme previews correctly and saves canonical bare HSL without losing other theme keys", () => {
  harness.theme = {
    primary: "hsl(152 60% 30%)",
    customFooter: "Retained theme value",
  };
  renderPage();
  const header = screen.getByTestId("preview-header");
  expect(header.style.backgroundColor).toBe("rgb(31, 122, 80)");
  expect(harness.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("button-save-branding"));
  expect(harness.mutate.mock.calls[0][0]).toMatchObject({
    id: "firm-1",
    data: {
      theme: { primary: "152 60% 30%", customFooter: "Retained theme value" },
    },
  });
});

test.each([
  "hsl(152 60% 30%",
  "152 60% 30%)",
  "hsl(hsl(152 60% 30%))",
  "361 60% 30%",
  "152 101% 30%",
  "152 60% 101%",
])(
  "malformed or out-of-range HSL %s is rejected before publishing",
  (primary) => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Primary colour (HSL)"), {
      target: { value: primary },
    });
    expect(
      screen
        .getByLabelText("Primary colour (HSL)")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.getByTestId("button-save-branding").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("preview-header").style.backgroundColor).toBe(
      "rgb(31, 122, 80)",
    );
    expect(harness.mutate).not.toHaveBeenCalled();
  },
);

test("loading retains a visible page heading without an enabled publish action", () => {
  harness.isLoading = true;
  renderPage();
  expect(
    screen.getByRole("heading", { level: 1, name: "Branding" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("button-save-branding")).toBeNull();
});

test.each([403, 500])(
  "HTTP %s retains a page heading and retry without offering publication",
  (status) => {
    harness.error = { status };
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "White-label branding" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(harness.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("button-save-branding")).toBeNull();
  },
);

test("feature-disabled endpoint retains the heading and never offers publication", () => {
  harness.error = { status: 404 };
  renderPage();
  expect(
    screen.getByRole("heading", { level: 1, name: "White-label branding" }),
  ).toBeTruthy();
  expect(screen.getByTestId("card-feature-unavailable")).toBeTruthy();
  expect(screen.queryByTestId("button-save-branding")).toBeNull();
});
