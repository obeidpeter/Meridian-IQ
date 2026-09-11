import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCreditGovernanceQueryKey,
  getGetCollectionFeedSpecificationQueryKey,
  useGetCollectionFeedSpecification,
  useGetCreditGovernance,
  useRecordBankDataRoomAccess,
  useRecordCreditKybCheck,
  useRunCreditAssessment,
  useRunCreditBacktest,
  type RecordBankDataRoomAccessInput,
  type RecordCreditKybInput,
  type CreditAssessment,
  type CreditVerificationState,
  type RunCreditAssessmentInput,
  type RunCreditBacktestInput,
} from "@workspace/api-client-react";
import { Metric, MetricStrip } from "@workspace/web-ui";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCheck2,
  Fingerprint,
  KeyRound,
  Landmark,
  Play,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { userErrorMessage } from "@/lib/errors";
import { humanize, pillClasses } from "@/lib/format";
import { compactNumber, pct, WorkspaceLoading } from "./shared";

const today = () => new Date().toISOString().slice(0, 10);
const oneYearAgo = () => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
};
const oneYearAhead = () => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
};

function useStableCommand<T extends { idempotencyKey: string }>() {
  const command = useRef<{
    fingerprint: string;
    payload: T;
  } | null>(null);

  return {
    resolve(
      fingerprintSource: unknown,
      build: () => Omit<T, "idempotencyKey">,
    ): T {
      const fingerprint = JSON.stringify(fingerprintSource);
      if (command.current?.fingerprint === fingerprint) {
        return command.current.payload;
      }
      const payload = {
        ...build(),
        idempotencyKey: crypto.randomUUID(),
      } as T;
      command.current = { fingerprint, payload };
      return payload;
    },
    complete() {
      command.current = null;
    },
  };
}

function FormSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Activity;
  children: React.ReactNode;
}) {
  return (
    <details className="group border border-slate-200 bg-white open:shadow-sm">
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-slate-100 text-teal-800">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-extrabold text-slate-950">
            {title}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-slate-500">
            {description}
          </span>
        </span>
        <span className="text-xs font-bold text-slate-500 group-open:hidden">
          Open
        </span>
        <span className="hidden text-xs font-bold text-slate-500 group-open:inline">
          Close
        </span>
      </summary>
      <div className="border-t border-slate-200 p-4">{children}</div>
    </details>
  );
}

function fieldClass() {
  return "space-y-1.5";
}

function NativeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: CreditVerificationState;
  onChange: (value: CreditVerificationState) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) =>
        onChange(event.target.value as CreditVerificationState)
      }
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="verified">Verified</option>
      <option value="review">Needs review</option>
      <option value="failed">Failed</option>
      <option value="not_checked">Not checked</option>
    </select>
  );
}

export function CreditGovernanceWorkspace() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const governance = useGetCreditGovernance({
    query: { queryKey: getGetCreditGovernanceQueryKey(), staleTime: 30_000 },
  });
  const feed = useGetCollectionFeedSpecification({
    query: {
      queryKey: getGetCollectionFeedSpecificationQueryKey(),
      staleTime: 5 * 60_000,
    },
  });
  const assess = useRunCreditAssessment();
  const backtest = useRunCreditBacktest();
  const recordKyb = useRecordCreditKybCheck();
  const bankAccess = useRecordBankDataRoomAccess();
  const assessmentCommand = useStableCommand<RunCreditAssessmentInput>();
  const backtestCommand = useStableCommand<RunCreditBacktestInput>();
  const kybCommand = useStableCommand<RecordCreditKybInput>();
  const bankAccessCommand = useStableCommand<RecordBankDataRoomAccessInput>();
  const [invoiceId, setInvoiceId] = useState("");
  const [assessment, setAssessment] = useState<CreditAssessment | null>(null);
  const [fromDate, setFromDate] = useState(oneYearAgo);
  const [toDate, setToDate] = useState(today);
  const [kyb, setKyb] = useState({
    firmId: "",
    partyId: "",
    beneficialOwnerCount: "1",
    ownershipCoverageBps: "10000",
    beneficialOwnersVerified: true,
    bankAccountOwnership: "verified" as CreditVerificationState,
    sanctionsScreening: "verified" as CreditVerificationState,
    pepScreening: "verified" as CreditVerificationState,
    adverseMediaScreening: "verified" as CreditVerificationState,
    provider: "manual-reviewed",
    providerReference: "",
    evidenceRefs: "",
    expiresAt: oneYearAhead(),
  });
  const [access, setAccess] = useState({
    bankPartyId: "",
    userId: "",
    action: "grant" as "grant" | "suspend" | "revoke",
    dpaReference: "",
    validUntil: oneYearAhead(),
    reason: "Approved institutional diligence access",
  });

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getGetCreditGovernanceQueryKey(),
    });
  const notifyError = (error: unknown) =>
    toast({
      title: "Credit control was not recorded",
      description: userErrorMessage(error),
      variant: "destructive",
    });

  if (governance.isLoading) return <WorkspaceLoading />;
  if (governance.isError || !governance.data) {
    return (
      <QueryError
        thing="credit governance"
        onRetry={() => governance.refetch()}
      />
    );
  }
  const data = governance.data;
  const activationProgress = Math.min(
    100,
    (data.activationEvidence.observableBusinesses /
      Math.max(1, data.activationEvidence.targetBusinesses)) *
      100,
  );

  const submitAssessment = (event: FormEvent) => {
    event.preventDefault();
    if (!invoiceId || assess.isPending) return;
    const data = assessmentCommand.resolve({ invoiceId }, () => ({
      invoiceId,
    }));
    assess.mutate(
      { data },
      {
        onSuccess: (result) => {
          assessmentCommand.complete();
          setAssessment(result);
          void refresh();
          toast({ title: `Assessment: ${humanize(result.decision)}` });
        },
        onError: notifyError,
      },
    );
  };

  const submitBacktest = (event: FormEvent) => {
    event.preventDefault();
    if (backtest.isPending) return;
    const data = backtestCommand.resolve({ fromDate, toDate }, () => ({
      fromDate,
      toDate,
    }));
    backtest.mutate(
      { data },
      {
        onSuccess: (result) => {
          backtestCommand.complete();
          void refresh();
          toast({
            title: result.passed
              ? "Structural replay passed"
              : "Back-test needs evidence",
            description: `${result.sampleSize} latest assessments replayed.`,
          });
        },
        onError: notifyError,
      },
    );
  };

  const submitKyb = (event: FormEvent) => {
    event.preventDefault();
    if (recordKyb.isPending) return;
    const data = kybCommand.resolve(kyb, () => ({
      firmId: kyb.firmId,
      partyId: kyb.partyId,
      beneficialOwnerCount: Number(kyb.beneficialOwnerCount),
      ownershipCoverageBps: Number(kyb.ownershipCoverageBps),
      beneficialOwnersVerified: kyb.beneficialOwnersVerified,
      bankAccountOwnership: kyb.bankAccountOwnership,
      sanctionsScreening: kyb.sanctionsScreening,
      pepScreening: kyb.pepScreening,
      adverseMediaScreening: kyb.adverseMediaScreening,
      provider: kyb.provider,
      providerReference: kyb.providerReference || null,
      evidenceRefs: kyb.evidenceRefs
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      checkedAt: new Date().toISOString(),
      expiresAt: `${kyb.expiresAt}T23:59:59.000Z`,
    }));
    recordKyb.mutate(
      { data },
      {
        onSuccess: (result) => {
          kybCommand.complete();
          void refresh();
          toast({ title: `KYB check recorded: ${humanize(result.status)}` });
        },
        onError: notifyError,
      },
    );
  };

  const submitAccess = (event: FormEvent) => {
    event.preventDefault();
    if (bankAccess.isPending) return;
    const data = bankAccessCommand.resolve(access, () => ({
      bankPartyId: access.bankPartyId,
      userId: access.userId,
      action: access.action,
      dpaReference: access.action === "grant" ? access.dpaReference : null,
      dpaExecutedAt:
        access.action === "grant" ? new Date().toISOString() : null,
      validUntil:
        access.action === "grant" ? `${access.validUntil}T23:59:59.000Z` : null,
      reason: access.reason,
    }));
    bankAccess.mutate(
      { data },
      {
        onSuccess: (result) => {
          bankAccessCommand.complete();
          void refresh();
          toast({ title: `Bank access ${humanize(result.action)}` });
        },
        onError: notifyError,
      },
    );
  };

  return (
    <div className="space-y-6">
      <MetricStrip label="Credit readiness summary">
        <Metric
          label="Credit-observable"
          value={compactNumber(data.activationEvidence.observableBusinesses)}
          detail={`Target ${compactNumber(data.activationEvidence.targetBusinesses)}`}
          icon={<Landmark className="size-4" aria-hidden="true" />}
          tone={data.activationReady ? "positive" : "warning"}
        />
        <Metric
          label="Assessed invoices"
          value={compactNumber(data.assessments.total)}
          detail={`${data.assessments.consentingBusinesses} consented businesses`}
          icon={<Database className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Current KYB"
          value={compactNumber(data.kyb.verified)}
          detail={`${data.kyb.attention + data.kyb.expired} need attention`}
          icon={<Fingerprint className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Governed bank users"
          value={compactNumber(data.bankAccess.activeUsers)}
          detail={`${data.bankAccess.views30d} Data Room views in 30 days`}
          icon={<KeyRound className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        <section className="border border-slate-200 bg-white">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-extrabold text-slate-950">
                R3 activation evidence
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Construction may proceed while these release gates keep the
                capability dark.
              </p>
            </div>
            <span
              className={pillClasses(
                data.activationReady ? "emerald" : "amber",
              )}
            >
              {data.activationReady
                ? "Ready for activation review"
                : `${data.blockers.length} blockers`}
            </span>
          </div>
          <div className="p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-bold text-slate-500">
                  Observable business gate
                </p>
                <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-950">
                  {data.activationEvidence.observableBusinesses}
                  <span className="text-sm font-bold text-slate-400">
                    {" "}
                    / {data.activationEvidence.targetBusinesses}
                  </span>
                </p>
              </div>
              <span className="text-xs font-bold text-slate-500">
                {Math.round(activationProgress)}%
              </span>
            </div>
            <Progress
              value={activationProgress}
              className="mt-3 h-2"
              aria-label="Observable business activation progress"
            />
            <ul className="mt-5 space-y-3">
              {data.blockers.length ? (
                data.blockers.map((blocker) => (
                  <li
                    key={blocker}
                    className="flex items-start gap-2 text-sm leading-5 text-slate-700"
                  >
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0 text-amber-600"
                      aria-hidden="true"
                    />
                    {blocker}
                  </li>
                ))
              ) : (
                <li className="flex items-start gap-2 text-sm font-bold text-emerald-800">
                  <CheckCircle2 className="size-4" aria-hidden="true" /> All
                  coded and documentary gates are evidenced.
                </li>
              )}
            </ul>
          </div>
        </section>

        <section className="border border-slate-200 bg-[#082f31] p-5 text-white">
          <h2 className="flex items-center gap-2 text-sm font-extrabold">
            <ShieldCheck className="size-4 text-[#e9cf78]" aria-hidden="true" />{" "}
            Control posture
          </h2>
          <dl className="mt-5 space-y-4 text-sm">
            {[
              [
                "Credit readiness",
                data.featurePosture.creditReadinessEnabled
                  ? "Platform on"
                  : `${data.featurePosture.creditPilotFirms} pilot firms`,
              ],
              [
                "Bank Data Room",
                data.featurePosture.bankDataRoomEnabled
                  ? "Platform on"
                  : "Dark",
              ],
              ["Scorecard", data.versions.scorecard],
              [
                "Structural replay",
                data.latestBacktest
                  ? data.latestBacktest.passed
                    ? "Passed"
                    : "Needs evidence"
                  : "Not run",
              ],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="border-b border-white/15 pb-3 last:border-0"
              >
                <dt className="text-xs text-white/60">{label}</dt>
                <dd className="mt-1 break-words font-bold">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="space-y-3" aria-labelledby="credit-controls-heading">
        <div>
          <h2
            id="credit-controls-heading"
            className="text-base font-extrabold text-slate-950"
          >
            Governed controls
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Writes are append-only and idempotent. No control below creates an
            offer, funds an invoice or moves money.
          </p>
        </div>

        <FormSection
          title="Run one eligibility assessment"
          description="Check saved invoices, buyer confirmations, settlement observations, business verification and concentration risk. This does not approve financing."
          icon={Play}
        >
          <form onSubmit={submitAssessment} className="space-y-4">
            <div className={fieldClass()}>
              <Label htmlFor="credit-invoice-id">Invoice ID</Label>
              <Input
                id="credit-invoice-id"
                value={invoiceId}
                onChange={(event) => setInvoiceId(event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                required
                pattern="[0-9a-fA-F-]{36}"
              />
            </div>
            <Button type="submit" disabled={assess.isPending || !invoiceId}>
              <Play className="size-4" aria-hidden="true" />{" "}
              {assess.isPending ? "Assessing..." : "Run assessment"}
            </Button>
            {assessment ? (
              <div
                className="border-l-4 border-teal-700 bg-slate-50 px-4 py-3"
                role="status"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-slate-950">
                    {humanize(assessment.decision)}
                  </strong>
                  <span
                    className={pillClasses(
                      assessment.decision === "eligible"
                        ? "emerald"
                        : assessment.decision === "manual_review"
                          ? "amber"
                          : "red",
                    )}
                  >
                    {assessment.score}/100
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {assessment.reasons[0] ?? "Every rule passed."}
                </p>
              </div>
            ) : null}
          </form>
        </FormSection>

        <FormSection
          title="Run structural back-test"
          description="Re-run stored records to check whether scorecard results have changed. This does not validate predictions of credit losses."
          icon={Activity}
        >
          <form onSubmit={submitBacktest} className="grid gap-4 sm:grid-cols-2">
            <div className={fieldClass()}>
              <Label htmlFor="credit-from">From</Label>
              <Input
                id="credit-from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="credit-to">To</Label>
              <Input
                id="credit-to"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                required
              />
            </div>
            <Button
              type="submit"
              className="sm:col-span-2 sm:w-fit"
              disabled={backtest.isPending || fromDate > toDate}
            >
              <Activity className="size-4" aria-hidden="true" />{" "}
              {backtest.isPending ? "Replaying..." : "Run structural replay"}
            </Button>
          </form>
        </FormSection>

        <FormSection
          title="Record business verification (KYB)"
          description="Save the verification result and reference IDs only. Personal identity documents stay with the provider."
          icon={Fingerprint}
        >
          <form
            onSubmit={submitKyb}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <div className={fieldClass()}>
              <Label htmlFor="kyb-firm">Firm ID</Label>
              <Input
                id="kyb-firm"
                value={kyb.firmId}
                onChange={(event) =>
                  setKyb({ ...kyb, firmId: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-party">Client record ID</Label>
              <Input
                id="kyb-party"
                value={kyb.partyId}
                onChange={(event) =>
                  setKyb({ ...kyb, partyId: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-provider">Provider</Label>
              <Input
                id="kyb-provider"
                value={kyb.provider}
                onChange={(event) =>
                  setKyb({ ...kyb, provider: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-owners">Beneficial owners</Label>
              <Input
                id="kyb-owners"
                type="number"
                min="0"
                max="100"
                value={kyb.beneficialOwnerCount}
                onChange={(event) =>
                  setKyb({ ...kyb, beneficialOwnerCount: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-coverage">
                Ownership coverage (basis points; 100 = 1%)
              </Label>
              <Input
                id="kyb-coverage"
                type="number"
                min="0"
                max="10000"
                value={kyb.ownershipCoverageBps}
                onChange={(event) =>
                  setKyb({ ...kyb, ownershipCoverageBps: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-expiry">Expires</Label>
              <Input
                id="kyb-expiry"
                type="date"
                min={today()}
                value={kyb.expiresAt}
                onChange={(event) =>
                  setKyb({ ...kyb, expiresAt: event.target.value })
                }
                required
              />
            </div>
            {(
              [
                "bankAccountOwnership",
                "sanctionsScreening",
                "pepScreening",
                "adverseMediaScreening",
              ] as const
            ).map((key) => (
              <div className={fieldClass()} key={key}>
                <Label htmlFor={`kyb-${key}`}>{humanize(key)}</Label>
                <NativeSelect
                  id={`kyb-${key}`}
                  value={kyb[key]}
                  onChange={(value) => setKyb({ ...kyb, [key]: value })}
                />
              </div>
            ))}
            <div className={fieldClass()}>
              <Label htmlFor="kyb-reference">Provider reference</Label>
              <Input
                id="kyb-reference"
                value={kyb.providerReference}
                onChange={(event) =>
                  setKyb({ ...kyb, providerReference: event.target.value })
                }
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="kyb-evidence">
                Evidence refs (comma-separated)
              </Label>
              <Input
                id="kyb-evidence"
                value={kyb.evidenceRefs}
                onChange={(event) =>
                  setKyb({ ...kyb, evidenceRefs: event.target.value })
                }
                placeholder="case:123, document:456"
              />
            </div>
            <label className="flex min-h-10 items-center gap-2 self-end text-sm font-bold text-slate-800">
              <Checkbox
                checked={kyb.beneficialOwnersVerified}
                onCheckedChange={(checked) =>
                  setKyb({ ...kyb, beneficialOwnersVerified: checked === true })
                }
              />
              Owners verified
            </label>
            <Button
              type="submit"
              className="sm:col-span-2 lg:col-span-3 lg:w-fit"
              disabled={recordKyb.isPending}
            >
              <FileCheck2 className="size-4" aria-hidden="true" />{" "}
              {recordKyb.isPending ? "Recording..." : "Record KYB check"}
            </Button>
          </form>
        </FormSection>

        <FormSection
          title="Manage bank access"
          description="Grant a bank user time-limited access under a signed data processing agreement (DPA), or suspend or revoke access immediately."
          icon={KeyRound}
        >
          <form
            onSubmit={submitAccess}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <div className={fieldClass()}>
              <Label htmlFor="access-bank">Bank record ID</Label>
              <Input
                id="access-bank"
                value={access.bankPartyId}
                onChange={(event) =>
                  setAccess({ ...access, bankPartyId: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="access-user">Bank user ID</Label>
              <Input
                id="access-user"
                value={access.userId}
                onChange={(event) =>
                  setAccess({ ...access, userId: event.target.value })
                }
                required
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="access-action">Action</Label>
              <select
                id="access-action"
                value={access.action}
                onChange={(event) =>
                  setAccess({
                    ...access,
                    action: event.target.value as typeof access.action,
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="grant">Grant</option>
                <option value="suspend">Suspend</option>
                <option value="revoke">Revoke</option>
              </select>
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="access-dpa">DPA reference</Label>
              <Input
                id="access-dpa"
                value={access.dpaReference}
                onChange={(event) =>
                  setAccess({ ...access, dpaReference: event.target.value })
                }
                required={access.action === "grant"}
                disabled={access.action !== "grant"}
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="access-until">Valid until</Label>
              <Input
                id="access-until"
                type="date"
                min={today()}
                value={access.validUntil}
                onChange={(event) =>
                  setAccess({ ...access, validUntil: event.target.value })
                }
                required={access.action === "grant"}
                disabled={access.action !== "grant"}
              />
            </div>
            <div className={fieldClass()}>
              <Label htmlFor="access-reason">Reason</Label>
              <Input
                id="access-reason"
                minLength={4}
                maxLength={500}
                value={access.reason}
                onChange={(event) =>
                  setAccess({ ...access, reason: event.target.value })
                }
                required
              />
            </div>
            <Button
              type="submit"
              className="sm:col-span-2 lg:col-span-3 lg:w-fit"
              disabled={bankAccess.isPending}
            >
              <KeyRound className="size-4" aria-hidden="true" />{" "}
              {bankAccess.isPending ? "Recording..." : "Record access event"}
            </Button>
          </form>
        </FormSection>
      </section>

      <section className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-extrabold text-slate-950">
            Collection-account feed profile
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            The contract banks agree before production activation.
          </p>
        </div>
        {feed.isLoading ? (
          <div className="p-5" role="status">
            <span className="text-sm text-slate-500">
              Loading feed profile...
            </span>
          </div>
        ) : feed.isError || !feed.data ? (
          <div className="p-5">
            <QueryError
              thing="the collection feed specification"
              onRetry={() => feed.refetch()}
            />
          </div>
        ) : (
          <dl className="grid gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Version", feed.data.version],
              ["Status", humanize(feed.data.status)],
              ["Transport", `${feed.data.transport} → ${feed.data.path}`],
              [
                "Delivery",
                `${humanize(feed.data.semantics)}, HTTP ${feed.data.acknowledgementStatus}`,
              ],
            ].map(([label, value]) => (
              <div key={String(label)} className="bg-white p-4">
                <dt className="text-xs font-bold text-slate-500">{label}</dt>
                <dd className="mt-1 break-words text-sm font-bold text-slate-900">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <p className="text-xs text-slate-500">
        Coverage: confirmation {pct(data.assessments.buyerConfirmationCoverage)}
        , settlement {pct(data.assessments.settlementObservationCoverage)}, KYB{" "}
        {pct(data.assessments.kybCoverage)}. All back-tests on this page are
        structural replay checks only.
      </p>
    </div>
  );
}
