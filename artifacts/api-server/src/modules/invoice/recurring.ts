// Recurring invoices: a standing instruction (retainers, subscriptions) that
// the sweep turns into ordinary drafts through the normal createDraft path —
// same validation, totals math and audit as manual entry. Drafts land in the
// standard review/submit workflow; nothing auto-submits.
import { and, desc, eq, lte } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  recurringInvoiceTemplatesTable,
  type RecurringInvoiceTemplate,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { createDraft } from "./service";
import { assertPlausibleVatRates, type LineInput } from "./lines";

export interface RecurringTemplateInput {
  supplierPartyId: string;
  buyerPartyId: string;
  name: string;
  cadence: "weekly" | "monthly";
  startDate: string;
  currency?: string;
  notes?: string | null;
  lines: LineInput[];
}

// A template far behind schedule (app asleep, template unpaused after months)
// catches up at most this many drafts per sweep pass, so a stale template
// cannot flood the book in one tick.
const CATCHUP_CAP = 6;

function assertCalendarDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new DomainError(
      "INVALID_DATE",
      `startDate must be a real YYYY-MM-DD calendar date, got "${value}"`,
      400,
    );
  }
}

// Advance one cadence step. Monthly clamps to the shorter month's last day
// (Jan 31 -> Feb 28/29) instead of JS Date's rollover into March.
export function advanceRunDate(
  dateStr: string,
  cadence: "weekly" | "monthly",
): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (cadence === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const day = d.getUTCDate();
  const firstOfNext = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  );
  const lastOfNext = new Date(
    Date.UTC(firstOfNext.getUTCFullYear(), firstOfNext.getUTCMonth() + 1, 0),
  ).getUTCDate();
  firstOfNext.setUTCDate(Math.min(day, lastOfNext));
  return firstOfNext.toISOString().slice(0, 10);
}

export async function createTemplate(
  firmId: string,
  input: RecurringTemplateInput,
  actorId: string,
): Promise<RecurringInvoiceTemplate> {
  if (input.lines.length === 0) {
    throw new DomainError("NO_LINES", "A template needs at least one line", 400);
  }
  // Same guard as createDraft: reject percent-style VAT rates at capture time
  // rather than on every future materialization.
  assertPlausibleVatRates(input.lines);
  assertCalendarDate(input.startDate);
  const [template] = await getDb()
    .insert(recurringInvoiceTemplatesTable)
    .values({
      firmId,
      supplierPartyId: input.supplierPartyId,
      buyerPartyId: input.buyerPartyId,
      name: input.name,
      cadence: input.cadence,
      nextRunDate: input.startDate,
      currency: input.currency ?? null,
      notes: input.notes ?? null,
      lines: input.lines,
      createdByUserId: actorId,
    })
    .returning();
  await appendAudit({
    actorId,
    firmId,
    action: "recurring_template_created",
    entityType: "recurring_template",
    entityId: template.id,
    after: { name: template.name, cadence: template.cadence },
  });
  return template;
}

export async function listTemplates(
  firmId: string | null,
  clientPartyId: string | null,
): Promise<RecurringInvoiceTemplate[]> {
  const conditions = [];
  if (firmId) conditions.push(eq(recurringInvoiceTemplatesTable.firmId, firmId));
  // SEC-03: a client_user sees only templates drafting for its own party.
  if (clientPartyId)
    conditions.push(
      eq(recurringInvoiceTemplatesTable.supplierPartyId, clientPartyId),
    );
  return getDb()
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(recurringInvoiceTemplatesTable.createdAt));
}

export async function getTemplate(
  id: string,
): Promise<RecurringInvoiceTemplate | null> {
  const [row] = await getDb()
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, id))
    .limit(1);
  return row ?? null;
}

export async function setTemplateActive(
  id: string,
  active: boolean,
  actorId: string,
): Promise<RecurringInvoiceTemplate> {
  const [updated] = await getDb()
    .update(recurringInvoiceTemplatesTable)
    .set({ active, updatedAt: new Date() })
    .where(eq(recurringInvoiceTemplatesTable.id, id))
    .returning();
  if (!updated) {
    throw new DomainError("NOT_FOUND", "Template not found", 404);
  }
  await appendAudit({
    actorId,
    firmId: updated.firmId,
    action: active ? "recurring_template_resumed" : "recurring_template_paused",
    entityType: "recurring_template",
    entityId: updated.id,
  });
  return updated;
}

// Deterministic per (template, run date): a re-run after a CAS miss or crash
// produces the same number, making duplicates visible rather than silent.
function invoiceNumberFor(template: RecurringInvoiceTemplate, runDate: string) {
  const tid = template.id.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `REC-${tid}-${runDate.replace(/-/g, "")}`;
}

export async function sweepRecurringInvoices(now = new Date()): Promise<number> {
  return runInBypassContext(() => sweepInner(now));
}

async function sweepInner(now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const due = await getDb()
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(
      and(
        eq(recurringInvoiceTemplatesTable.active, true),
        lte(recurringInvoiceTemplatesTable.nextRunDate, today),
      ),
    );
  let materialized = 0;
  for (const template of due) {
    let runDate = template.nextRunDate;
    for (let i = 0; i < CATCHUP_CAP && runDate <= today; i++) {
      const next = advanceRunDate(runDate, template.cadence);
      // CAS-advance first: only the pass that wins the date moves on to
      // draft, so a concurrent trigger cannot double-materialize a period.
      const advanced = await getDb()
        .update(recurringInvoiceTemplatesTable)
        .set({ nextRunDate: next, updatedAt: new Date() })
        .where(
          and(
            eq(recurringInvoiceTemplatesTable.id, template.id),
            eq(recurringInvoiceTemplatesTable.nextRunDate, runDate),
          ),
        )
        .returning({ id: recurringInvoiceTemplatesTable.id });
      if (advanced.length === 0) break; // another pass claimed this period

      const bundle = await createDraft(
        {
          firmId: template.firmId,
          supplierPartyId: template.supplierPartyId,
          buyerPartyId: template.buyerPartyId,
          invoiceNumber: invoiceNumberFor(template, runDate),
          issueDate: runDate,
          currency: template.currency ?? undefined,
          notes: template.notes,
          lines: template.lines,
        },
        template.createdByUserId,
      );
      await getDb()
        .update(recurringInvoiceTemplatesTable)
        .set({ lastInvoiceId: bundle.invoice.id })
        .where(eq(recurringInvoiceTemplatesTable.id, template.id));
      materialized++;
      runDate = next;
    }
  }
  return materialized;
}
