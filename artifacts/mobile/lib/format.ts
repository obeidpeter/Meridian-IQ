/**
 * Shared display formatters for the mobile app.
 *
 * NGN amounts arrive from the API as decimal strings (e.g. "1075000.00").
 * We format them with the ₦ symbol and thousands separators, mirroring the
 * offline estimator's formatNaira.
 */

export function formatCurrency(value: string | number | null | undefined): string {
  const num = typeof value === "string" ? Number(value) : value ?? 0;
  const safe = Number.isFinite(num) ? (num as number) : 0;
  const [whole, fraction] = Math.abs(safe).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = safe < 0 ? "-" : "";
  const decimals = fraction === "00" ? "" : `.${fraction}`;
  return `${sign}\u20A6${grouped}${decimals}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const FULL_MONTHS = [
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

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Short date, e.g. "5 Mar 2027". */
export function formatDate(value: string | Date): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Short date with time, e.g. "5 Mar 2027, 14:05". */
export function formatDateTime(value: string | Date): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(d)}, ${hours}:${minutes}`;
}

/** Month + year grouping key label, e.g. "March 2027". */
export function formatMonthYear(value: string | Date): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "Undated";
  return `${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Sortable YYYY-MM key for grouping. */
export function monthKey(value: string | Date): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "0000-00";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Whole calendar days from now until the given date (negative if past). */
export function daysUntil(value: string | Date): number {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date();
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Human countdown, e.g. "in 12 days", "today", "3 days overdue". */
export function countdownLabel(value: string | Date): string {
  const days = daysUntil(value);
  if (days === 0) return "Due today";
  if (days > 0) return `In ${days} day${days === 1 ? "" : "s"}`;
  const overdue = -days;
  return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
}

/** Relative time for activity items, e.g. "2h ago", "3d ago". */
export function timeAgo(value: string | Date): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

/** Title-case a snake_case or lower status token, e.g. "due_soon" → "Due Soon". */
export function humanize(token: string | null | undefined): string {
  if (!token) return "";
  return token
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
