import { gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { invoicesTable } from "@workspace/db";
import Decimal from "decimal.js";
import { DomainError } from "../errors";
import { isCalendarDate, decimalInputError } from "./input-validation";

const groups = {
  draft: ["draft", "validated"],
  pending: ["submitted"],
  stamped: ["stamped", "confirmed"],
  settled: ["settled"],
  failed: ["failed"],
  closed: ["credited", "cancelled"],
} as const;

export function invoicePageFilters(query: {
  statusGroup?: string;
  fromDate?: string;
  toDate?: string;
  minAmount?: string;
  maxAmount?: string;
}): SQL[] {
  const conditions: SQL[] = [];
  if (query.statusGroup && query.statusGroup !== "all") {
    const group = groups[query.statusGroup as keyof typeof groups];
    if (!group)
      throw new DomainError(
        "INVALID_FILTER",
        "Invalid invoice status group",
        400,
      );
    conditions.push(inArray(invoicesTable.status, [...group]));
  }
  for (const field of ["fromDate", "toDate"] as const) {
    if (query[field] && !isCalendarDate(query[field]))
      throw new DomainError(
        "INVALID_FILTER",
        `${field} must be a valid calendar date`,
        400,
      );
  }
  if (query.fromDate && query.toDate && query.fromDate > query.toDate)
    throw new DomainError(
      "INVALID_FILTER",
      "From date cannot be after to date",
      400,
    );
  if (query.fromDate)
    conditions.push(gte(invoicesTable.issueDate, query.fromDate));
  if (query.toDate) conditions.push(lte(invoicesTable.issueDate, query.toDate));
  const amount = sql`CASE WHEN ${invoicesTable.currency} = 'NGN' THEN ${invoicesTable.grandTotal} ELSE ${invoicesTable.grandTotal} * ${invoicesTable.fxRateToNgn} END`;
  for (const field of ["minAmount", "maxAmount"] as const) {
    if (query[field] === undefined) continue;
    const error = decimalInputError(query[field], field, 22, 2, false);
    if (error) throw new DomainError("INVALID_FILTER", error, 400);
    conditions.push(
      field === "minAmount"
        ? sql`${amount} >= ${query[field]}::numeric`
        : sql`${amount} <= ${query[field]}::numeric`,
    );
  }
  if (
    query.minAmount &&
    query.maxAmount &&
    new Decimal(query.minAmount).gt(query.maxAmount)
  )
    throw new DomainError(
      "INVALID_FILTER",
      "Minimum amount cannot exceed maximum amount",
      400,
    );
  return conditions;
}
