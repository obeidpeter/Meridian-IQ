import { ValoMark } from "@workspace/web-ui";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  useGetMe,
  useCaptureConsent,
} from "@workspace/api-client-react";
import { BarChart3, FileCheck2, Landmark, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverErrorMessage } from "@/lib/errors";

/**
 * CORE-03 first-landing capture (architecture.md D15). A client user whose
 * business has never recorded a layer-1 decision sees this step instead of
 * the workspace — once. Layers 1 and 2 are explicit choices (allow / not
 * now), layer 3 is explained as a separate optional decision after setup,
 * and every answer is an append-only
 * consent event with channel "first_landing", so declining is recorded too
 * and the step never re-prompts. Firm users and buyers pass straight through:
 * consent belongs to the business's own account.
 */

type Decision = "grant" | "revoke";

const LAYERS = [
  {
    layer: 1,
    title: "Compliance & submission",
    scope: "compliance_submission",
    icon: FileCheck2,
    description:
      "Lets Valo validate, submit and vault your invoices, and send you deadline alerts. Without it, nothing can be submitted on your behalf.",
    declineNote:
      "Without this, Valo cannot submit or stamp invoices for you. You can allow it later from Consent.",
  },
  {
    layer: 2,
    title: "Anonymized benchmarking",
    scope: "anonymized_benchmark",
    icon: BarChart3,
    description:
      "Allows your data to feed anonymized, aggregate industry benchmarks. Never shown with your name attached.",
    declineNote: null,
  },
] as const;

export function ConsentCapture({
  clientPartyId,
  onCaptured,
}: {
  clientPartyId: string;
  onCaptured: () => void;
}) {
  const capture = useCaptureConsent();
  const [commandId] = useState(() => crypto.randomUUID());
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = LAYERS.every((l) => decisions[l.layer]);

  const decide = (layer: number, decision: Decision) => {
    setError(null);
    setDecisions((d) => ({ ...d, [layer]: decision }));
  };

  const submit = async () => {
    if (!complete || saving) return;
    setSaving(true);
    setError(null);
    try {
      await capture.mutateAsync({
        id: clientPartyId,
        data: {
          commandId,
          decisions: LAYERS.map((l) => ({
            layer: l.layer,
            action: decisions[l.layer],
          })),
        },
      });
      onCaptured();
    } catch (e) {
      setError(serverErrorMessage(e));
      setSaving(false);
    }
  };

  return (
    <main
      className="min-h-screen bg-[var(--mi-canvas)] px-4 py-8 text-foreground sm:px-6"
      data-testid="consent-capture"
    >
      <div className="mx-auto w-full max-w-2xl">
        <div className="mi-brand mb-8 !text-[var(--mi-ink)]">
          <span className="mi-brand__mark !bg-[var(--mi-teal-soft)] !text-[var(--mi-teal)]">
            <ValoMark aria-hidden="true" />
          </span>
          <span>
            <span className="mi-brand__name">Valo</span>
            <span className="mi-brand__caption !text-[var(--mi-muted)]">
              Compliance Workspace
            </span>
          </span>
        </div>

        <p className="mi-eyebrow">Before you start</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Choose what Valo may do for your business
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          These are your permissions, recorded in a ledger you can read and
          change at any time from Consent. Nothing is switched on quietly: each
          choice below is written down, including &ldquo;not now&rdquo;.
        </p>

        <div className="mt-8 space-y-4">
          {LAYERS.map((l) => {
            const Icon = l.icon;
            const chosen = decisions[l.layer];
            return (
              <section
                key={l.layer}
                className="rounded-[var(--mi-radius)] border border-card-border bg-card p-5 shadow-sm"
                data-testid={`consent-capture-layer-${l.layer}`}
                aria-labelledby={`consent-capture-title-${l.layer}`}
              >
                <div className="flex items-start gap-3">
                  <span className="mi-card-icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2
                      id={`consent-capture-title-${l.layer}`}
                      className="text-base font-bold"
                    >
                      {l.title}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        Layer {l.layer}
                      </span>
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {l.description}
                    </p>
                    <div
                      className="mt-3 flex flex-wrap gap-2"
                      role="group"
                      aria-label={`${l.title} decision`}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant={chosen === "grant" ? "default" : "outline"}
                        aria-pressed={chosen === "grant"}
                        onClick={() => decide(l.layer, "grant")}
                        data-testid={`button-consent-allow-${l.layer}`}
                      >
                        <ShieldCheck className="size-4" aria-hidden="true" />
                        Allow
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={chosen === "revoke" ? "secondary" : "outline"}
                        aria-pressed={chosen === "revoke"}
                        onClick={() => decide(l.layer, "revoke")}
                        data-testid={`button-consent-decline-${l.layer}`}
                      >
                        Not now
                      </Button>
                    </div>
                    {chosen === "revoke" && l.declineNote ? (
                      <p
                        className="mt-3 rounded-md border border-[var(--mi-warning)]/30 bg-[var(--mi-warning-soft)] px-3 py-2 text-xs leading-5 text-[var(--mi-warning)]"
                        role="status"
                        data-testid={`text-consent-decline-note-${l.layer}`}
                      >
                        {l.declineNote}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
            );
          })}

          <section
            className="rounded-[var(--mi-radius)] border border-dashed border-card-border bg-card/60 p-5"
            data-testid="consent-capture-layer-3"
            aria-labelledby="consent-capture-title-3"
          >
            <div className="flex items-start gap-3">
              <span className="mi-card-icon" data-tone="info">
                <Landmark aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="consent-capture-title-3"
                  className="flex flex-wrap items-center gap-2 text-base font-bold"
                >
                  Credit readiness
                  <span className="text-xs font-normal text-muted-foreground">
                    Layer 3
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                    Optional after setup
                  </span>
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Credit readiness is separate from these setup permissions. It
                  never applies for finance or moves money. You can review the
                  full privacy terms and make an explicit Layer 3 choice from
                  Consent after entering your workspace.
                </p>
              </div>
            </div>
          </section>
        </div>

        {error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {complete
              ? "Both choices recorded once you continue."
              : "Answer both to continue. You can change either later."}
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={!complete || saving}
            data-testid="button-consent-continue"
          >
            {saving ? "Recording…" : "Continue to your workspace"}
          </Button>
        </div>
      </div>
    </main>
  );
}

/**
 * The gate: renders the capture step for a client user whose business has no
 * layer-1 decision yet, and the workspace for everyone else. It reads the same
 * /me the session guard loaded, so it costs no extra round trip.
 */
export function RequireConsentCapture({ children }: { children: ReactNode }) {
  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const queryClient = useQueryClient();
  const needsCapture =
    me?.role === "client_user" &&
    !!me.clientPartyId &&
    me.consentCaptured === false;
  if (needsCapture && me?.clientPartyId) {
    return (
      <ConsentCapture
        clientPartyId={me.clientPartyId}
        onCaptured={() =>
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() })
        }
      />
    );
  }
  return <>{children}</>;
}
