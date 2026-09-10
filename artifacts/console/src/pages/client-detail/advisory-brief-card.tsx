import {
  useListAdvisoryBriefs,
  getListAdvisoryBriefsQueryKey,
  useGenerateAdvisoryBrief,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { serverErrorToast } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";

// ---- Advisory brief (Advise with Clerk, round 49) ---------------------------
// The firm's monthly advisory work product for this client: deterministic
// evidence-cited sections composed from the platform's own reports, the
// adviser's note phrased at most once (template fallback). Generation is
// firm-side (engagement.write); regenerating within the month refreshes the
// same row.

export function AdvisoryBriefCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: briefs, isSuccess } = useListAdvisoryBriefs(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListAdvisoryBriefsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  const generate = useGenerateAdvisoryBrief({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListAdvisoryBriefsQueryKey({ clientPartyId }),
        });
        toast({ title: "Advisory brief refreshed." });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not generate the brief",
          fallback: "Try again.",
        }),
    },
  });
  if (!isSuccess) return null;
  const brief = briefs?.[0];
  return (
    <Card data-testid="card-advisory-brief">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <Sparkles aria-hidden="true" />
          </span>
          Advisory brief
        </CardTitle>
        <Button
          size="sm"
          onClick={() => generate.mutate({ data: { clientPartyId } })}
          disabled={generate.isPending}
          data-testid="button-generate-brief"
        >
          {generate.isPending
            ? "Generating…"
            : brief
              ? "Refresh brief"
              : "Generate brief"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The month's advisory position, composed from the client's own reports
          — statutory clocks, penalty exposure, VAT, money position and books
          hygiene. Every number cites the report it comes from; only the short
          adviser's note is phrased.
        </p>
        {!brief ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-brief-empty"
          >
            No brief yet for this client — generate the first one.
          </p>
        ) : (
          <div className="space-y-2" data-testid="advisory-brief-body">
            <p className="font-medium" data-testid="text-brief-headline">
              {brief.headline}
            </p>
            <p className="text-sm text-muted-foreground">{brief.note}</p>
            {brief.sections.map((section) => (
              <div
                key={section.key}
                className="border rounded-md p-3 space-y-1"
                data-testid={`brief-section-${section.key}`}
              >
                <p className="text-sm font-medium">{section.title}</p>
                <p className="text-sm">{section.text}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {section.facts.map((f) => (
                    <p key={f.key}>
                      {f.label}:{" "}
                      <span className="font-medium tabular-nums">
                        {f.value}
                        {f.unit ? ` ${f.unit}` : ""}
                      </span>
                    </p>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Source: {section.sourceReport}
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Covers{" "}
              {new Date(
                `${brief.monthStart.slice(0, 7)}-15`,
              ).toLocaleDateString("en-NG", { month: "long", year: "numeric" })}
              {brief.source === "clerk" && " · note written by Clerk"} · last
              refreshed {formatDateTime(brief.updatedAt)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
