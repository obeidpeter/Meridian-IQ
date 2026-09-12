import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { EvidenceErrorMessage } from "./evidence-controls";
import { useEvidenceRead } from "./evidence-state";
import type { EvidenceApi } from "./evidence-types";

export function EvidenceRecordPicker({
  api,
  kind,
  clientPartyId,
  value,
  onChange,
  required = false,
}: {
  api: EvidenceApi;
  kind: "invoiceId" | "filingId";
  clientPartyId: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const load = kind === "invoiceId" ? api.invoices : api.filings;
  const records = useEvidenceRead(
    (signal) =>
      load?.(clientPartyId, search, offset, signal) ??
      Promise.resolve({ items: [], hasMore: false }),
    [kind, clientPartyId, search, offset],
  );
  return (
    <div className="grid gap-2 min-w-0">
      {kind === "invoiceId" && (
        <label className="evidence-field">
          <span>Find invoice</span>
          <input
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
              onChange("");
            }}
            autoComplete="off"
          />
        </label>
      )}
      <label className="evidence-field">
        <span>{kind === "invoiceId" ? "Invoice" : "Filing"}</span>
        <select
          value={value}
          required={required}
          disabled={records.loading || !!records.error}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {required ? "Select a record" : "All records"}
          </option>
          {records.data?.items.map((record) => (
            <option key={record.id} value={record.id}>
              {record.label}
            </option>
          ))}
        </select>
      </label>
      {records.loading && (
        <p role="status" className="evidence-muted">
          Loading records...
        </p>
      )}
      {!records.loading && !records.error && !records.data?.items.length && (
        <p className="evidence-muted">No matching records on this page.</p>
      )}
      <EvidenceErrorMessage error={records.error} retry={records.refresh} />
      {(offset > 0 || records.data?.hasMore) && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous records"
            title="Previous records"
            disabled={!offset || records.loading}
            onClick={() => {
              setOffset(Math.max(0, offset - 50));
              onChange("");
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="More records"
            title="More records"
            disabled={!records.data?.hasMore || records.loading}
            onClick={() => {
              setOffset(offset + 50);
              onChange("");
            }}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
