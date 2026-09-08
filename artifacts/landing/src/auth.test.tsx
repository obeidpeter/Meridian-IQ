// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import App from "./App";
import { AcceptInvite } from "./AcceptInvite";
import { ResetPassword } from "./ResetPassword";

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  challenge: vi.fn(),
  requestReset: vi.fn(),
  reset: vi.fn(),
  preview: vi.fn(),
  accept: vi.fn(),
  refetch: vi.fn(),
  meStatus: 401,
  token: null as string | null,
  previewError: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    error: { status: auth.meStatus },
    refetch: auth.refetch,
  }),
  getGetMeQueryKey: () => ["/api/me"],
  useLogin: () => ({ mutateAsync: auth.login }),
  useTotpChallenge: () => ({ mutateAsync: auth.challenge }),
  useRequestPasswordReset: () => ({
    mutateAsync: auth.requestReset,
    isPending: false,
  }),
  useResetPassword: () => ({
    mutateAsync: auth.reset,
    isPending: false,
    isSuccess: false,
  }),
  useAcceptInvite: () => ({
    mutateAsync: auth.accept,
    isPending: false,
    isSuccess: false,
  }),
  usePreviewInvitation: () => ({
    mutate: auth.preview,
    isPending: false,
    isIdle: false,
    isError: auth.previewError,
    error: { status: 400 },
    data: {
      email: "ada@example.test",
      workspaceName: "Example Accounting",
      role: "firm_staff",
    },
  }),
}));

vi.mock("@workspace/web-ui", () => ({
  ValoMark: () => <svg aria-hidden="true" />,
  lazyRoute: () => () => null,
  SessionBoundary: ({ children }: { children: ReactNode }) => children,
  trackUsabilityEvent: vi.fn(),
  webSession: {
    mutationCacheOptions: {},
    getGeneration: () => 0,
  },
}));

vi.mock("./lib/query-secret", () => ({
  takeQuerySecret: () => auth.token,
  clearQuerySecret: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;

describe("auth contrast and target tokens", () => {
  const stylesheet = document.createElement("style");

  beforeAll(() => {
    stylesheet.textContent = readFileSync(
      resolve(import.meta.dirname, "auth.css"),
      "utf8",
    );
    document.head.append(stylesheet);
  });

  afterAll(() => stylesheet.remove());

  function declaration(selector: string, property: string): string {
    const rule = Array.from(stylesheet.sheet!.cssRules).find(
      (candidate): candidate is CSSStyleRule =>
        "selectorText" in candidate && candidate.selectorText === selector,
    );
    expect(rule, `Missing ${selector}`).toBeDefined();
    return rule!.style.getPropertyValue(property).trim();
  }

  function luminance(color: string): number {
    const hex =
      color.length === 4
        ? `#${[...color.slice(1)].map((channel) => channel.repeat(2)).join("")}`
        : color;
    expect(hex).toMatch(/^#[\da-f]{6}$/i);
    const channels = [1, 3, 5].map((offset) => {
      const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  test("separates interactive boundaries from decorative rules at 3:1 contrast", () => {
    const boundary = declaration(".valo-auth", "--auth-input-rule");
    expect(boundary).toBe("#7e8776");
    expect(declaration(".valo-auth", "--auth-rule")).toBe("#d5d8d0");
    expect(
      declaration(
        ".valo-auth :is(.auth-input, .auth-flow-panel input)",
        "border",
      ),
    ).toBe("1px solid var(--auth-input-rule)");
    expect(declaration(".valo-auth .auth-secondary", "border-color")).toBe(
      "var(--auth-input-rule)",
    );
    expect(declaration(".valo-auth .auth-header", "border-bottom")).toBe(
      "1px solid var(--auth-rule)",
    );
    expect(declaration(".valo-auth .auth-role-list", "border-block")).toBe(
      "1px solid var(--auth-rule)",
    );
    for (const surface of ["--auth-paper", "--auth-canvas"]) {
      const values = [
        luminance(boundary),
        luminance(declaration(".valo-auth", surface)),
      ];
      const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      expect(ratio, `Interactive border on ${surface}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  test("keeps the header home link at least 44px tall", async () => {
    await render();
    const home = container.querySelector<HTMLAnchorElement>(
      ".auth-header .auth-brand",
    )!;
    expect(home.getAttribute("aria-label")).toBe("Valo home");
    expect(home.getAttribute("href")).toBe("/");
    expect(
      Number.parseFloat(getComputedStyle(home).minHeight),
    ).toBeGreaterThanOrEqual(44);
  });
});

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = container.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing test element: ${id}`);
  return element;
}

async function render(element: ReactNode = <App />) {
  await act(async () => root.render(element));
}

async function fill(id: string, value: string) {
  const input = byTestId<HTMLInputElement>(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function enterCredentials() {
  await fill("input-email", "ada@example.test");
  await fill("input-password", "example-password");
  await submit();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.meStatus = 401;
  auth.token = null;
  auth.previewError = false;
  window.history.replaceState(null, "", "/login");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth presentation contracts", () => {
  test("keeps sign-in landmarks, labels, autofocus and password visibility", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Welcome back");
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("aria-labelledby")).toBe("access-story-title");
    expect(container.querySelector("#access-story-title")?.textContent).toBe(
      "One account. The right workspace.",
    );
    expect(aside.querySelectorAll("li")).toHaveLength(4);
    expect(
      container.querySelector("main")!.compareDocumentPosition(aside) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(byTestId("input-email"));
    expect(container.querySelector('label[for="email"]')?.textContent).toBe(
      "Work email",
    );
    expect(container.querySelector('label[for="password"]')?.textContent).toBe(
      "Password",
    );
    expect(byTestId("input-email").getAttribute("autocomplete")).toBe(
      "username",
    );
    expect(byTestId("input-password").getAttribute("autocomplete")).toBe(
      "current-password",
    );
    expect(byTestId<HTMLButtonElement>("button-sign-in").disabled).toBe(true);
    expect(byTestId("link-forgot-password").getAttribute("href")).toBe(
      "/reset-password",
    );
    expect(byTestId("link-request-access").getAttribute("href")).toBe(
      "/#request-access",
    );
    await act(async () => byTestId("button-toggle-password").click());
    expect(byTestId<HTMLInputElement>("input-password").type).toBe("text");
    expect(byTestId("button-toggle-password").getAttribute("aria-label")).toBe(
      "Hide password",
    );
    await act(async () => byTestId("button-toggle-password").click());
    expect(byTestId<HTMLInputElement>("input-password").type).toBe("password");
  });

  test("keeps expired-session guidance and accessible login failures", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?reason=expired&returnTo=/app/invoices",
    );
    auth.login.mockRejectedValue({ status: 401 });
    await render();
    expect(byTestId("text-session-expired").getAttribute("role")).toBe(
      "status",
    );
    await enterCredentials();
    expect(auth.login).toHaveBeenCalledWith({
      data: { email: "ada@example.test", password: "example-password" },
    });
    expect(byTestId("text-login-error").getAttribute("role")).toBe("alert");
    expect(byTestId("input-email").getAttribute("aria-describedby")).toBe(
      "login-error",
    );
    expect(document.activeElement).toBe(byTestId("input-email"));
    expect(byTestId<HTMLInputElement>("input-email").value).toBe(
      "ada@example.test",
    );
  });

  test("keeps MFA recovery codes, focus, errors and password restart", async () => {
    auth.login.mockResolvedValue({
      mfaRequired: true,
      mfaToken: "fixture-token",
    });
    auth.challenge.mockRejectedValue({ status: 401 });
    await render();
    await enterCredentials();
    expect(container.querySelector("h1")?.textContent).toBe("Enter your code");
    expect(document.activeElement).toBe(byTestId("input-totp-code"));
    expect(byTestId("input-totp-code").getAttribute("autocomplete")).toBe(
      "one-time-code",
    );
    expect(byTestId("input-totp-code").getAttribute("aria-describedby")).toBe(
      "totp-help",
    );
    expect(byTestId("text-totp-expiry").textContent).toBe(
      "about 5 minutes left",
    );
    await fill("input-totp-code", "saved-recovery-code");
    await submit();
    expect(auth.challenge).toHaveBeenCalledWith({
      data: { mfaToken: "fixture-token", code: "saved-recovery-code" },
    });
    expect(byTestId("text-totp-error").getAttribute("role")).toBe("alert");
    expect(byTestId("input-totp-code").getAttribute("aria-describedby")).toBe(
      "totp-error",
    );
    expect(document.activeElement).toBe(byTestId("input-totp-code"));
    await act(async () => byTestId("button-totp-restart").click());
    expect(byTestId<HTMLInputElement>("input-email").value).toBe(
      "ada@example.test",
    );
    expect(byTestId<HTMLInputElement>("input-password").value).toBe("");
  });

  test("keeps MFA expiry on the existing password restart path", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    auth.login.mockResolvedValue({
      mfaRequired: true,
      mfaToken: "fixture-token",
    });
    auth.challenge.mockRejectedValue({ status: 401 });
    await render();
    await enterCredentials();
    now.mockReturnValue(1_300_001);
    await fill("input-totp-code", "123456");
    await submit();
    expect(byTestId("text-login-error").textContent).toContain("expired");
    expect(byTestId<HTMLInputElement>("input-password").value).toBe("");
  });

  test("keeps outage retry and local sign-out notices", async () => {
    auth.meStatus = 503;
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "We can't reach Valo right now.",
    );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(auth.refetch).toHaveBeenCalledOnce();
    window.history.replaceState(null, "", "/login?reason=local-signout");
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Server sign-out could not be confirmed",
    );
  });

  test("keeps password recovery non-enumerating and preserves support links", async () => {
    auth.requestReset.mockResolvedValue(undefined);
    await render(<ResetPassword />);
    expect(container.querySelector(".valo-auth.auth-flow")).not.toBeNull();
    expect(byTestId("link-guidance-sign-in").getAttribute("href")).toBe(
      "/login",
    );
    expect(byTestId("link-guidance-support").getAttribute("href")).toMatch(
      /^mailto:/,
    );
    await fill("input-reset-email", "ada@example.test");
    await submit();
    expect(auth.requestReset).toHaveBeenCalledWith({
      data: { email: "ada@example.test" },
    });
    expect(byTestId("text-reset-request-sent").getAttribute("role")).toBe(
      "status",
    );
    expect(byTestId("text-reset-request-sent").textContent).toContain(
      "If an account exists",
    );
  });

  test("keeps reset password mismatch and invalid-token feedback", async () => {
    auth.token = "fixture-reset-token";
    auth.reset.mockRejectedValue({ status: 400 });
    await render(<ResetPassword />);
    await fill("input-reset-password", "new-example-password");
    await fill("input-reset-confirm", "different-password");
    expect(byTestId<HTMLButtonElement>("button-set-password").disabled).toBe(
      true,
    );
    expect(byTestId("input-reset-confirm").getAttribute("aria-invalid")).toBe(
      "true",
    );
    await fill("input-reset-confirm", "new-example-password");
    await submit();
    expect(auth.reset).toHaveBeenCalledWith({
      data: { token: "fixture-reset-token", password: "new-example-password" },
    });
    expect(byTestId("text-reset-error").textContent).toContain(
      "invalid or has expired",
    );
    expect(document.activeElement).toBe(byTestId("input-reset-password"));
  });

  test("keeps invitation identity and password confirmation", async () => {
    auth.token = "fixture-invite-token";
    await render(<AcceptInvite />);
    expect(auth.preview).toHaveBeenCalledWith({
      data: { token: "fixture-invite-token" },
    });
    expect(byTestId("text-invite-email").textContent).toBe("ada@example.test");
    expect(byTestId("text-invite-workspace").textContent).toBe(
      "Example Accounting",
    );
    expect(byTestId("text-invite-role").textContent).toBe("Firm team member");
    await fill("input-invite-password", "example-password");
    await fill("input-invite-confirm-password", "different-password");
    expect(byTestId("text-invite-mismatch").textContent).toBe(
      "Passwords do not match.",
    );
    expect(byTestId<HTMLButtonElement>("button-accept-invite").disabled).toBe(
      true,
    );
  });

  test("keeps unavailable invitation guidance without exposing the form", async () => {
    auth.token = "fixture-invite-token";
    auth.previewError = true;
    await render(<AcceptInvite />);
    expect(byTestId("card-invite-preview-error").textContent).toContain(
      "Invitation unavailable",
    );
    expect(container.querySelector("form")).toBeNull();
    await act(async () => byTestId("button-retry-invite-preview").click());
    expect(auth.preview).toHaveBeenCalledTimes(2);
  });
});
