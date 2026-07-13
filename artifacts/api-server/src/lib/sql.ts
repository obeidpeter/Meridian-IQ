// Escape LIKE wildcards so a user typing "50%" searches for the literal
// characters instead of matching everything.
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
