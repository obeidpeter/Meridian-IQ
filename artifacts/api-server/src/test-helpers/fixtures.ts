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
