import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export type TodayPriority = keyof typeof PRIORITY_RANK;
export type TodayCounts = {
  total: number;
  urgent: number;
  dueSoon: number;
  blocked: number;
};

export function emptyTodayCounts(): TodayCounts {
  return { total: 0, urgent: 0, dueSoon: 0, blocked: 0 };
}

export function addTodayCounts(
  rows: Array<TodayCounts | undefined>,
): TodayCounts {
  return rows.reduce<TodayCounts>(
    (total, row) => ({
      total: total.total + (row?.total ?? 0),
      urgent: total.urgent + (row?.urgent ?? 0),
      dueSoon: total.dueSoon + (row?.dueSoon ?? 0),
      blocked: total.blocked + (row?.blocked ?? 0),
    }),
    emptyTodayCounts(),
  );
}

export function dueDate(value: string | null): Date | null {
  return value ? new Date(`${value}T23:59:59+01:00`) : null;
}

export function priorityFor(date: Date | null, now: Date): TodayPriority {
  if (!date) return "normal";
  const remaining = date.getTime() - now.getTime();
  if (remaining < 0) return "urgent";
  return remaining <= 3 * DAY_MS ? "high" : "normal";
}

export function dueDescription(date: Date | null, now: Date): string {
  if (!date) return "No due date";
  const remaining = date.getTime() - now.getTime();
  if (remaining < 0) {
    const days = Math.ceil(-remaining / DAY_MS);
    return `${days} day${days === 1 ? "" : "s"} overdue`;
  }
  // Day labels use the platform's Nigerian calendar, not the server timezone.
  const day = (value: Date) =>
    Math.floor((value.getTime() + 60 * 60 * 1000) / DAY_MS);
  const days = day(date) - day(now);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

export function sortToday<
  T extends { id: string; priority: TodayPriority; dueAt: Date | null },
>(items: T[]): T[] {
  return items.sort((a, b) => {
    const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priority !== 0) return priority;
    if (a.dueAt && b.dueAt) {
      const due = a.dueAt.getTime() - b.dueAt.getTime();
      if (due !== 0) return due;
    } else if (a.dueAt) return -1;
    else if (b.dueAt) return 1;
    // UUID order agrees with PostgreSQL; prefixes are constant within a source.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function dueDateSql(column: SQLWrapper): SQL {
  return sql`((${column} + time '23:59:59') AT TIME ZONE 'Africa/Lagos')`;
}

export function datePrioritySql(
  due: SQLWrapper,
  now: Date,
  options: { failed?: SQL; awaitingConfirmation?: SQL } = {},
): SQL<number> {
  return sql<number>`case
    when ${options.failed ?? sql`false`} or ${due} < ${now.toISOString()}::timestamptz then 0
    when ${options.awaitingConfirmation ?? sql`false`} or ${due} <= ${new Date(now.getTime() + 3 * DAY_MS).toISOString()}::timestamptz then 1
    else 2 end`;
}

export function workPrioritySql(priority: SQLWrapper): SQL<number> {
  return sql<number>`case ${priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
}

// Window aggregates see the complete scoped WHERE result before ORDER BY/LIMIT.
// Keeping them in the candidate query also prevents a count/list snapshot race.
export function todayCountFields(
  due: SQLWrapper,
  rank: SQLWrapper,
  status: SQLWrapper,
  now: Date,
) {
  return {
    total: sql<number>`count(*) over ()`.mapWith(Number),
    urgent: sql<number>`count(*) filter (where ${rank} = 0) over ()`.mapWith(
      Number,
    ),
    dueSoon:
      sql<number>`count(*) filter (where ${due} >= ${now.toISOString()}::timestamptz
      and ${due} <= ${new Date(now.getTime() + 3 * DAY_MS).toISOString()}::timestamptz) over ()`.mapWith(
        Number,
      ),
    blocked:
      sql<number>`count(*) filter (where ${status}::text in ('blocked', 'failed')) over ()`.mapWith(
        Number,
      ),
  };
}
