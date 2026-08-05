// Dependency-free fixture helpers shared across test files.

// Opaque per-run uniqueness token: distinct across concurrently running test
// files via the pid, distinct across runs via the timestamp. Nothing parses
// it — only uniqueness matters.
export function makeRunSalt(): string {
  return `${Date.now().toString(36)}${process.pid}`;
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Exact Lagos calendar date N days from now (WAT is fixed UTC+1, no DST), so
// day-boundary predicates are tested without flakiness. One home — this was
// copy-pasted across seven test files before refactor round 7.
export function lagosDateOffset(days: number): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
