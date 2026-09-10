// The operator queue's pure kernels (R126 split): the handle-time format
// and the brief's spend line. The unit suite pins spendAlertsLine through
// the page's index module.

export function formatDuration(seconds?: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// The brief's spend line: >0 firm spend anomalies today is an
// attention-needed warning (the audit ledger has the detail); zero renders
// the same quiet all-clear the escalation line uses.
export function spendAlertsLine(count: number): string {
  if (count === 0) return "No firm spend anomalies today.";
  return `${count} firm spend ${count === 1 ? "anomaly" : "anomalies"} today — check the audit log.`;
}
