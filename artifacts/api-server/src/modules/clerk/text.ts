// Shared micro-formatting for Clerk's deterministic template narratives
// (digest, client statement, Ask data intents). Pure string helpers only —
// anything with policy in it (Lagos calendars, month windows) stays with its
// owning module.

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
