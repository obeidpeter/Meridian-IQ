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

// English ordinal for a day-of-month ("21st", "10th"): teens are always
// "th" (11th/12th/13th); everything else follows the last digit.
export function ordinal(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
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
