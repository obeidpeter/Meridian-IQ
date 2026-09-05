// Share one limiter across probes: condition polling must not hammer the
// scheduler's default 12/minute quota or silently ignore failed passes.
export function createSweepTrigger(request, base, token, now = Date.now) {
  let nextAt = 0;
  return async () => {
    if (now() < nextAt) return;
    nextAt = now() + 6_000;
    const response = await request.get(`${base}/api/internal/sweep`, {
      headers: { "x-op-token": token },
      timeout: 10_000,
    });
    const status = response.status();
    if (status === 429) {
      const raw = response.headers()["retry-after"];
      const seconds = Number(raw);
      const delay =
        raw && Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1_000
          : Date.parse(raw) - now();
      nextAt = Math.max(
        nextAt,
        now() + (Number.isFinite(delay) ? Math.max(0, delay) : 60_000),
      );
      return;
    }
    const body = await response.json().catch(() => null);
    if (status === 200 && body?.status === "ok") return;
    if (status === 202 && body?.status === "busy") return;
    // Never print a raw response: it may contain internal errors or secrets.
    throw new Error(
      `integration journey: scheduler pass failed (HTTP ${status})`,
    );
  };
}

export async function invoiceProbeDiagnostic(request, base, invoiceId) {
  const invoice = await request.get(`${base}/api/invoices/${invoiceId}`, {
    timeout: 10_000,
  });
  const bundle = invoice.status() === 200 ? await invoice.json() : null;
  const attempts = await request.get(
    `${base}/api/invoices/${invoiceId}/attempts`,
    { timeout: 10_000 },
  );
  const rows = attempts.status() === 200 ? await attempts.json() : null;
  const status = bundle?.invoice?.status;
  const allowed = [
    "draft",
    "validated",
    "submitted",
    "stamped",
    "failed",
    "cancelled",
    "credited",
    "settled",
  ];
  return `invoice HTTP ${invoice.status()}, state ${allowed.includes(status) ? status : "unknown"}; attempts HTTP ${attempts.status()}, count ${Array.isArray(rows) ? rows.length : "unknown"}`;
}
