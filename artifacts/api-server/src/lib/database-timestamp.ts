export type DatabaseTimestamp = Date | string;

// Drizzle maps selected timestamp columns to Date, but raw execute() keeps
// node-postgres timestamp strings. Require a timezone instead of assuming the
// application server's local timezone for a malformed/ambiguous raw value.
export function databaseTimestampIso(value: unknown): string {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    const match =
      /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?)(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
        value,
      );
    if (!match) throw new TypeError("Invalid database timestamp");
    const day = new Date(`${match[1]}T00:00:00Z`);
    if (
      !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== match[1]
    ) {
      throw new TypeError("Invalid database timestamp");
    }
    const offset =
      match[3].length === 3
        ? `${match[3]}:00`
        : match[3].length === 5
          ? `${match[3].slice(0, 3)}:${match[3].slice(3)}`
          : match[3];
    date = new Date(`${match[1]}T${match[2]}${offset}`);
  } else {
    throw new TypeError("Invalid database timestamp");
  }
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("Invalid database timestamp");
  return date.toISOString();
}
