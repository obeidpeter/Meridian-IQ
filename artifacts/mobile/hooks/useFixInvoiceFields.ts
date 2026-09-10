import type { InvoiceDetail } from "@workspace/api-client-react";
import { useEffect, useMemo, useState } from "react";

import {
  invoiceFieldsDirty,
  isContentEditable,
  linesFromDetail,
} from "@/lib/fix-invoice";
import { blankLine, computeTotals } from "@/lib/invoice-form";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";

/**
 * The fix-invoice form's own fields: the invoice number, dates, notes and
 * line drafts prefilled once from the loaded invoice, their inline errors,
 * the optimistic-concurrency revision, and the editability/dirty flags the
 * shell saves and guards on.
 */
export function useFixInvoiceFields(detail: InvoiceDetail | undefined) {
  const invoice = detail?.invoice;

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);

  useEffect(() => {
    if (prefilled || !detail) return;
    const inv = detail.invoice;
    setExpectedRevision(inv.contentRevision);
    setInvoiceNumber(inv.invoiceNumber);
    setIssueDate(inv.issueDate);
    setDueDate(inv.dueDate ?? "");
    setNotes(inv.notes ?? "");
    setLines(linesFromDetail(detail.lines));
    setPrefilled(true);
  }, [detail, prefilled]);

  const editable = isContentEditable(invoice);

  const [lineErrors, setLineErrors] = useState<LineErrors>({});
  const [issueDateError, setIssueDateError] = useState<string | null>(null);
  const [dueDateError, setDueDateError] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(lines), [lines]);

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLinesDirty(true);
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
    setLineErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  const addLine = () => {
    setLinesDirty(true);
    setLines((prev) => [
      ...prev,
      blankLine(`new-${Date.now()}-${prev.length}`),
    ]);
  };
  const removeLine = (key: string) => {
    setLinesDirty(true);
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.key !== key),
    );
  };

  // Dirty check: any typed change to the invoice fields. Together with the
  // lines and party drafts it gates the unsaved-changes guard.
  const fieldsDirty = invoiceFieldsDirty(invoice, {
    invoiceNumber,
    issueDate,
    dueDate,
    notes,
  });

  return {
    invoiceNumber,
    setInvoiceNumber,
    issueDate,
    setIssueDate,
    dueDate,
    setDueDate,
    notes,
    setNotes,
    lines,
    linesDirty,
    setLinesDirty,
    prefilled,
    setPrefilled,
    expectedRevision,
    setExpectedRevision,
    lineErrors,
    setLineErrors,
    issueDateError,
    setIssueDateError,
    dueDateError,
    setDueDateError,
    editable,
    fieldsDirty,
    totals,
    updateLine,
    addLine,
    removeLine,
  };
}

export type FixInvoiceFields = ReturnType<typeof useFixInvoiceFields>;
