export function deployedBuildRevision(): string {
  const candidate = [
    process.env.BUILD_REVISION,
    process.env.REPLIT_GIT_SHA,
    process.env.REPLIT_DEPLOYMENT_ID,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
  ]
    .map((value) => value?.trim())
    .find(Boolean);
  if (!candidate)
    return process.env.NODE_ENV === "production" ? "unknown" : "development";
  return /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : "unknown";
}

export function expectedBuildRevision(): string | null {
  const candidate = process.env.EXPECTED_BUILD_REVISION?.trim();
  return candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
    ? candidate
    : null;
}

export function revisionsMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const gitRevision = /^[0-9a-f]{7,40}$/i;
  return (
    gitRevision.test(actual) &&
    gitRevision.test(expected) &&
    (actual.startsWith(expected) || expected.startsWith(actual))
  );
}
