import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetComplianceProfile,
  useUpdateComplianceProfile,
  useGetFilingPenaltyExposure,
  getGetComplianceProfileQueryKey,
  getGetComplianceProfileSummaryQueryKey,
  getGetFilingPenaltyExposureQueryKey,
} from "@workspace/api-client-react";
import type { ComplianceProfile } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { formatDate, formatNaira } from "@/lib/format";
import { ClipboardCheck } from "lucide-react";

// The client's statutory profile (Compliance Profile round): the per-client
// facts a HUMAN at the firm asserts — VAT-registered, PAYE employer,
// financial year end, incorporation date. A client with NO profile keeps the
// original mint-both behaviour (VAT and PAYE rows every period); asserting
// the profile narrows the monthly minting honestly and unlocks the ANNUAL
// returns (CIT due 6 months after the FYE; CAC annual due 30 June; the
// employer annual return due 31 January). The platform never infers any of
// these facts — extraction proposes nothing here; this card is the one place
// the firm states them.
//
// Unlike the empty-book null-render cards (wht-card, matrix-card), the
// UNASSERTED state renders: absence is the story — the explainer tells the
// firm what the default means and offers the assert form. Writes gate on the
// filing.write capability (the profile route's own assert), mirrored here so
// a read-only viewer (auditor) sees the facts but no buttons that could only
// ever 403 — the filings-card posture.
//
// The exposure strip is deliberately worded "estimated exposure", never
// "penalty owed": overdue ANNUAL returns produce an estimate the firm uses
// to prioritise, not a bill.

// ---- Pure helpers (unit-tested directly) -----------------------------------

export const FYE_MONTH_NAMES = [
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

/** "3" of the contract's 1-12 → "March"; null (or off-range) → "Not captured". */
export function fyeMonthLabel(month: number | null | undefined): string {
  return (month != null && FYE_MONTH_NAMES[month - 1]) || "Not captured";
}

/** The asserted-state facts line, one string so the test pins the wording. */
export function profileFacts(
  p: Pick<
    ComplianceProfile,
    "vatRegistered" | "payeEmployer" | "fyeMonth" | "incorporationDate"
  >,
): string {
  const yn = (b: boolean) => (b ? "Yes" : "No");
  return [
    `VAT-registered: ${yn(p.vatRegistered)}`,
    `PAYE employer: ${yn(p.payeEmployer)}`,
    `FYE: ${fyeMonthLabel(p.fyeMonth)}`,
    `Incorporated: ${
      p.incorporationDate ? formatDate(p.incorporationDate) : "Not captured"
    }`,
  ].join(" · ");
}

// ---- The card ---------------------------------------------------------------

export function ComplianceProfileCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useGetComplianceProfile(
    clientPartyId,
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetComplianceProfileQueryKey(clientPartyId),
        staleTime: 60_000,
        retry: false,
      },
    },
  );

  // Estimated exposure for OVERDUE annual returns only — the server returns
  // rows solely when an annual register row is past its due date, and
  // totalNgn "0.00" when the client is clean, so the strip hides itself.
  const exposureParams = { clientPartyId };
  const { data: exposure } = useGetFilingPenaltyExposure(exposureParams, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetFilingPenaltyExposureQueryKey(exposureParams),
      staleTime: 60_000,
      retry: false,
    },
  });

  // Profile writes assertCan filing.write server-side (firm staff). Mirror
  // that here so a read-only viewer sees no dead buttons.
  const { data: me } = useGetMe();
  const canWrite = !!me?.capabilities.includes("filing.write");

  // The form's draft. Nothing is pre-selected on a first assert beyond the
  // false defaults the contract requires — a human names each fact.
  const [editing, setEditing] = useState(false);
  const [vat, setVat] = useState(false);
  const [paye, setPaye] = useState(false);
  const [fye, setFye] = useState(""); // "" = not captured, else "1".."12"
  const [incorporation, setIncorporation] = useState("");
  const [notes, setNotes] = useState("");

  const profile = data?.profile ?? null;

  const openForm = () => {
    // Editing seeds from the asserted facts; a first assert starts from the
    // contract's false/null defaults.
    setVat(profile?.vatRegistered ?? false);
    setPaye(profile?.payeEmployer ?? false);
    setFye(profile?.fyeMonth != null ? String(profile.fyeMonth) : "");
    setIncorporation(profile?.incorporationDate ?? "");
    setNotes(profile?.notes ?? "");
    setEditing(true);
  };

  const update = useUpdateComplianceProfile({
    mutation: {
      onSuccess: () => {
        // The profile drives this card's facts, the portfolio checklist's
        // summary, and (after the next register sync) the annual rows —
        // refresh the two read surfaces here.
        void queryClient.invalidateQueries({
          queryKey: getGetComplianceProfileQueryKey(clientPartyId),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetComplianceProfileSummaryQueryKey(),
        });
        setEditing(false);
        toast({ title: "Statutory profile saved" });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not save the profile",
          fallback: "Try again.",
        }),
    },
  });

  const save = () =>
    // Optionals travel as null, never "" — the contract's nullable trio.
    update.mutate({
      id: clientPartyId,
      data: {
        vatRegistered: vat,
        payeEmployer: paye,
        fyeMonth: fye ? Number(fye) : null,
        incorporationDate: incorporation ? incorporation : null,
        notes: notes.trim() ? notes.trim() : null,
      },
    });

  const exposureRows = exposure?.rows ?? [];

  return (
    <Card data-testid="card-compliance-profile">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="w-5 h-5" aria-hidden="true" /> Statutory
          profile
        </CardTitle>
        {canWrite && !editing && !isLoading && !error && (
          <Button
            size="sm"
            variant="outline"
            onClick={openForm}
            data-testid={profile ? "button-profile-edit" : "button-profile-assert"}
          >
            {profile ? "Edit profile" : "Assert profile"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton
            className="h-24 w-full"
            data-testid="skeleton-compliance-profile"
          />
        ) : error ? (
          <QueryError
            thing="the statutory profile"
            onRetry={() => refetch()}
            detail={error instanceof Error ? error.message : undefined}
          />
        ) : editing ? (
          <div className="space-y-3" data-testid="form-compliance-profile">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="profile-vat">VAT-registered</Label>
              <Switch
                id="profile-vat"
                checked={vat}
                onCheckedChange={setVat}
                data-testid="input-profile-vat"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="profile-paye">PAYE employer</Label>
              <Switch
                id="profile-paye"
                checked={paye}
                onCheckedChange={setPaye}
                data-testid="input-profile-paye"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="profile-fye">Financial year end</Label>
                <select
                  id="profile-fye"
                  value={fye}
                  onChange={(e) => setFye(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  data-testid="select-profile-fye"
                >
                  <option value="">Not captured</option>
                  {FYE_MONTH_NAMES.map((name, i) => (
                    <option key={name} value={String(i + 1)}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="profile-incorporation">
                  Incorporation date
                </Label>
                <Input
                  id="profile-incorporation"
                  type="date"
                  value={incorporation}
                  onChange={(e) => setIncorporation(e.target.value)}
                  data-testid="input-profile-incorporation"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="profile-notes">Notes (optional)</Label>
              <Textarea
                id="profile-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[70px] text-sm"
                data-testid="input-profile-notes"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={save}
                disabled={update.isPending}
                data-testid="button-profile-save"
              >
                {update.isPending ? "Saving…" : "Save profile"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : profile ? (
          <div>
            <p className="text-sm" data-testid="text-profile-facts">
              {profileFacts(profile)}
            </p>
            {profile.notes && (
              <p
                className="text-xs text-muted-foreground mt-1"
                data-testid="text-profile-notes"
              >
                {profile.notes}
              </p>
            )}
          </div>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-profile-unasserted"
          >
            No statutory profile yet — VAT and PAYE returns are both tracked
            until you assert what applies.
          </p>
        )}
        {exposureRows.length > 0 && exposure && (
          <p
            className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            data-testid="text-profile-exposure"
          >
            Estimated late-filing exposure: {formatNaira(exposure.totalNgn)}{" "}
            across {exposureRows.length} overdue return
            {exposureRows.length === 1 ? "" : "s"}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The firm asserts these facts; the platform never infers them.
        </p>
      </CardContent>
    </Card>
  );
}
