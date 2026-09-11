import { confirmationLabel } from "@/lib/format";

export const FILTERS = [
  { key: "all", label: "All" },
  { key: "none", label: "Not requested" },
  { key: "requested", label: confirmationLabel("requested") },
  { key: "confirmed", label: "Confirmed" },
  { key: "queried", label: confirmationLabel("queried") },
  { key: "rejected", label: "Rejected" },
] as const;

export type FilterKey = (typeof FILTERS)[number]["key"];
export const FILTER_KEYS = FILTERS.map((item) => item.key);

export const PAGE_SIZE = 25;
export const SERVER_PAGE_SIZE = 100;

// The bulk endpoint accepts at most this many invoice ids per call — the
// header "Select all" stops here, and a hand-picked overflow disables the
// button with a reason instead of collecting a guaranteed 400.
export const BULK_LIMIT = 50;

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
