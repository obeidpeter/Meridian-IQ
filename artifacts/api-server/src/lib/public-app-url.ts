// R112: the one home for the canonical public origin. Every link the platform
// sends (password recovery, Invoice Room shares) is built on PUBLIC_APP_URL —
// never on a hostname baked into the code, which would outlive a domain move,
// and never on a request's Host header, which the caller controls. Production
// refuses to become ready without a safe value: assertPublicAppUrlConfigured
// runs in the boot sequence, so a rollout probing /api/readyz fails instead of
// mailing links to the wrong origin. Outside production an unset value falls
// back to the local Vite origin so the e2e harness and a developer shell keep
// working.

export interface PublicAppUrlEnvironment {
  NODE_ENV?: string;
  PUBLIC_APP_URL?: string;
}

/** The verdict never carries the configured value, so it is safe to log. */
export type PublicAppUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export const DEVELOPMENT_PUBLIC_APP_URL = "http://localhost:5173";

export function checkPublicAppUrl(
  env: PublicAppUrlEnvironment = process.env,
): PublicAppUrlCheck {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (!configured) return { ok: false, reason: "PUBLIC_APP_URL is not set" };
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { ok: false, reason: "PUBLIC_APP_URL is not an absolute URL" };
  }
  const localHttp =
    env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    return { ok: false, reason: "PUBLIC_APP_URL must be an https origin" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "PUBLIC_APP_URL must not carry credentials" };
  }
  return { ok: true, url };
}

/** The configured public origin, or null when it is unset or unsafe. */
export function publicAppUrl(
  env: PublicAppUrlEnvironment = process.env,
): URL | null {
  const verdict = checkPublicAppUrl(env);
  return verdict.ok ? verdict.url : null;
}

/** Production boot gate: throws — holding readiness — until a safe origin is
 *  configured; a no-op outside production. The message carries the reason,
 *  never the value. */
export function assertPublicAppUrlConfigured(
  env: PublicAppUrlEnvironment = process.env,
): void {
  if (env.NODE_ENV !== "production") return;
  const verdict = checkPublicAppUrl(env);
  if (!verdict.ok) {
    throw new Error(
      `Production requires a safe public origin for the links it sends: ${verdict.reason}`,
    );
  }
}

/** A link on the public origin whose credential rides in the URL fragment,
 *  which browsers never send in requests, access logs or Referer headers.
 *  Null in production when no safe origin is configured: the boot gate makes
 *  that unreachable for a live process, and callers treat it as dark delivery
 *  rather than falling back to any other host. */
export function publicAppLink(
  pathname: string,
  fragment: Record<string, string>,
  env: PublicAppUrlEnvironment = process.env,
): string | null {
  const base =
    publicAppUrl(env) ??
    (env.NODE_ENV === "production"
      ? null
      : new URL(DEVELOPMENT_PUBLIC_APP_URL));
  if (!base) return null;
  const link = new URL(pathname, base);
  link.hash = Object.entries(fragment)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return link.toString();
}
