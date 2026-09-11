import { useState, type ReactNode } from "react";
import {
  useGetExtractionPrompt,
  useRunPromptCanary,
  useRunModelCanary,
  getGetExtractionPromptQueryKey,
} from "@workspace/api-client-react";
import type {
  ModelCanaryReport,
  PromptCanaryReport,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollRegion } from "@/components/scroll-region";
import { useToast } from "@/hooks/use-toast";
import { userErrorMessage } from "@/lib/errors";
import { formatPct, pillClasses, type BadgeTone } from "@/lib/format";
import {
  EVAL_RISK_TONE,
  modelCanaryRowClass,
  canaryPrefillNote,
} from "./format";

// The prompt and model canary cards of the Canaries tab (R110: split out of
// the page).

const VERDICT_TONE: Record<string, BadgeTone> = {
  improvement: "emerald",
  comparable: "slate",
  regression: "red",
};

// One side of a canary report (incumbent or candidate): accuracy and
// injection resistance for that side. `meta` is the card-specific header
// suffix — the prompt canary shows the prompt version, the model canary its
// font-mono model id.
function CanarySide({
  label,
  meta,
  stats,
  testId,
}: {
  label: string;
  meta: ReactNode;
  stats: {
    fieldsCompared: number;
    fieldsCorrect: number;
    accuracy: number | null;
    injectionFixtures: number;
    injectionResisted: number;
    failures: number;
  };
  testId: string;
}) {
  return (
    <div
      className="rounded-md border p-3 space-y-1 text-sm"
      data-testid={testId}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase">
        {label} · {meta}
      </p>
      <p>
        Accuracy:{" "}
        <span className="font-semibold tabular-nums">
          {stats.accuracy != null ? formatPct(stats.accuracy) : "—"}
        </span>{" "}
        <span className="text-muted-foreground">
          ({stats.fieldsCorrect}/{stats.fieldsCompared} fields)
        </span>
      </p>
      <p>
        Injection resisted:{" "}
        <span className="font-semibold tabular-nums">
          {stats.injectionResisted}/{stats.injectionFixtures}
        </span>
        {stats.failures > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · {stats.failures} failed call(s)
          </span>
        )}
      </p>
    </div>
  );
}

// The deterministic verdict pill plus the server's one-line reason.
function CanaryVerdict({
  verdict,
  reason,
}: {
  verdict: string;
  reason: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={pillClasses(VERDICT_TONE[verdict] ?? "slate")}>
        {verdict}
      </span>
      <p className="text-sm">{reason}</p>
    </div>
  );
}

// The trailing corpus-size footnote both canary reports end with.
function CanaryFootnote({
  fixtureCount,
  truncated,
}: {
  fixtureCount: number;
  truncated: boolean;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {fixtureCount} fixture(s)
      {truncated ? " (corpus truncated to the canary cap)" : ""} · both sides
      ran the same corpus through the live gateway.
    </p>
  );
}

// When the incumbent-prompt fetch fails, the prefill button cannot work —
// say WHY next to the permanently disabled control instead of leaving a dead
// button: the canary itself still runs fine on a hand-pasted candidate.

export function PromptCanaryCard() {
  const { toast } = useToast();
  const { data: incumbent, isError: incumbentFailed } = useGetExtractionPrompt({
    query: { queryKey: getGetExtractionPromptQueryKey(), retry: false },
  });
  const prefillNote = canaryPrefillNote(incumbentFailed);
  const [candidate, setCandidate] = useState("");
  const [report, setReport] = useState<PromptCanaryReport | null>(null);
  const canary = useRunPromptCanary({
    mutation: {
      onSuccess: (res) => setReport(res),
      onError: (e) =>
        toast({
          title: "Canary failed",
          description:
            userErrorMessage(e) ?? "Could not run the comparison test.",
          variant: "destructive",
        }),
    },
  });

  const side = (label: string, s: PromptCanaryReport["incumbent"]) => (
    <CanarySide
      label={label}
      meta={s.promptVersion}
      stats={s}
      testId={`canary-${label}`}
    />
  );

  return (
    <Card data-testid="section-prompt-canary">
      <CardHeader>
        <CardTitle className="text-base">Prompt canary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Test a candidate extraction prompt against the incumbent over the same
          eval corpus — twice the model calls of an evaluation run. The verdict
          is deterministic: injection resistance may never drop, and accuracy is
          judged outside a 2% noise band. Nothing is stored; promoting a prompt
          is a code change.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!incumbent}
            onClick={() => incumbent && setCandidate(incumbent.system)}
            data-testid="button-canary-prefill"
          >
            Start from the live prompt
          </Button>
          {prefillNote && (
            <p
              className="text-xs text-destructive"
              data-testid="text-canary-prefill-error"
            >
              {prefillNote}
            </p>
          )}
        </div>
        <Label htmlFor="canary-candidate" className="sr-only">
          Candidate system prompt
        </Label>
        <Textarea
          id="canary-candidate"
          value={candidate}
          onChange={(e) => {
            setCandidate(e.target.value);
            setReport(null);
          }}
          placeholder="Paste or edit the candidate system prompt (min 100 characters)…"
          className="min-h-[140px] font-mono text-xs"
          data-testid="input-canary-candidate"
        />
        <Button
          size="sm"
          disabled={canary.isPending || candidate.trim().length < 100}
          onClick={() =>
            canary.mutate({ data: { candidateSystem: candidate } })
          }
          data-testid="button-run-canary"
        >
          {canary.isPending ? "Running canary…" : "Run canary"}
        </Button>
        {report && (
          <div className="space-y-3" data-testid="canary-report">
            <CanaryVerdict
              verdict={report.verdict}
              reason={report.verdictReason}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {side("incumbent", report.incumbent)}
              {side("candidate", report.candidate)}
            </div>
            {report.fixtures.some((f) => f.regressed) && (
              <div className="text-xs text-muted-foreground">
                Regressed fixtures:{" "}
                {report.fixtures
                  .filter((f) => f.regressed)
                  .map((f) => f.label)
                  .join("; ")}
              </div>
            )}
            <CanaryFootnote
              fixtureCount={report.fixtureCount}
              truncated={report.truncated}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Model canary: the prompt canary's twin for models — run the eval corpus
// under a CANDIDATE model and the incumbent side by side. Decision support
// only — the verdict rule is deterministic and server-side, nothing is
// stored, and switching models is an env change (CLERK_MODEL_TIERS) the
// operator makes with this evidence in hand.
export function ModelCanaryCard() {
  const { toast } = useToast();
  const [candidate, setCandidate] = useState("");
  const [report, setReport] = useState<ModelCanaryReport | null>(null);
  const canary = useRunModelCanary({
    mutation: {
      onSuccess: (res) => setReport(res),
      onError: (e) =>
        toast({
          title: "Model canary failed",
          description:
            userErrorMessage(e) ?? "Could not run the model comparison test.",
          variant: "destructive",
        }),
    },
  });

  const side = (label: string, s: ModelCanaryReport["incumbent"]) => (
    <CanarySide
      label={label}
      meta={<span className="normal-case font-mono">{s.model}</span>}
      stats={s}
      testId={`model-canary-${label}`}
    />
  );

  return (
    <Card data-testid="section-model-canary">
      <CardHeader>
        <CardTitle className="text-base">Model canary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Test a candidate model against the incumbent over the same eval corpus
          — twice the model calls of an evaluation run. The verdict is
          deterministic: injection resistance may never drop, and accuracy is
          judged outside a 2% noise band. Nothing is stored; adopting a model is
          an env change (CLERK_MODEL_TIERS), canary first.
        </p>
        <Input
          value={candidate}
          onChange={(e) => {
            setCandidate(e.target.value);
            setReport(null);
          }}
          placeholder="Candidate model id…"
          maxLength={120}
          aria-label="Candidate model"
          data-testid="input-model-candidate"
        />
        <Button
          size="sm"
          disabled={canary.isPending || candidate.trim().length === 0}
          onClick={() =>
            canary.mutate({ data: { candidateModel: candidate.trim() } })
          }
          data-testid="button-run-model-canary"
        >
          {canary.isPending ? "Running canary…" : "Run canary"}
        </Button>
        {report && (
          <div className="space-y-3" data-testid="model-canary-report">
            <CanaryVerdict
              verdict={report.verdict}
              reason={report.verdictReason}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {side("incumbent", report.incumbent)}
              {side("candidate", report.candidate)}
            </div>
            <ScrollRegion label="Model canary fixtures table">
              <table
                className="w-full text-sm"
                data-testid="table-model-canary-fixtures"
              >
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Fixture</th>
                    <th className="py-2 pr-3 font-medium">Risk</th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Incumbent
                    </th>
                    <th className="py-2 font-medium text-right">Candidate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.fixtures.map((f) => (
                    <tr
                      key={f.key}
                      className={modelCanaryRowClass(f.regressed)}
                      data-testid={`row-model-fixture-${f.key}`}
                    >
                      <td className="py-2 pr-3">
                        {f.label}
                        {f.regressed && (
                          <span className="ml-2 text-[10px] font-medium uppercase text-red-600 dark:text-red-400">
                            regressed
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={pillClasses(
                            EVAL_RISK_TONE[f.riskLabel] ?? "slate",
                          )}
                        >
                          {f.riskLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {f.incumbentCorrect}/{f.fieldsCompared}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {f.candidateCorrect}/{f.fieldsCompared}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <CanaryFootnote
              fixtureCount={report.fixtureCount}
              truncated={report.truncated}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Eval corpus curation --------------------------------------------------
// The full fixture inventory (static, grown, red-team) with per-fixture pass
// history reconstructed from stored runs. Curation is scoped on purpose:
// grown/red-team fixtures can be retired (and restored) from the UI; static
// fixtures ship in code, so their rows stay read-only with a tooltip saying
// why.
