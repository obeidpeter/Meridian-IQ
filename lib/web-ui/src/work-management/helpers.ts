import type {
  CollaborativeAssigneeOption,
  CollaborativeWorkStatus,
} from "./types";

export const statusItems: Array<{
  value: "active" | "done" | "all";
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "done", label: "Completed" },
  { value: "all", label: "All" },
];

export function formatWhen(value: string | null): string {
  if (!value) return "No due date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function displayStatus(status: CollaborativeWorkStatus): string {
  return status.replace("_", " ");
}

export function assigneesFor(
  assignees: CollaborativeAssigneeOption[],
  scope: string | null,
): CollaborativeAssigneeOption[] {
  return assignees.filter(
    (assignee) => !assignee.clientPartyId || assignee.clientPartyId === scope,
  );
}
