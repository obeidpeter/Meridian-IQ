import {
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
  useListAdvisoryBriefs,
  getListAdvisoryBriefsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, CalendarCheck } from "lucide-react";
import { Link } from "wouter";
import { formatDate } from "@/lib/format";
import { statementMonthLabel } from "./helpers";

// "Your week" — the firm's latest weekly Clerk digest. Firm-only surface
// (clerk.ask, like the Ask Clerk page): the parent checks the capability
// before mounting this, so a client_user never fires the request. Read-only
// and pre-generated server-side, so it spends no tokens; renders only on
// success — no digest yet (404) or any error means no card at all.
export function ClerkDigestCard() {
  const { data: digest, isSuccess } = useGetClerkDigest({
    query: { queryKey: getGetClerkDigestQueryKey(), retry: false },
  });
  if (!isSuccess || !digest) return null;
  return (
    <Card data-testid="clerk-digest">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Your week
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold">{digest.headline}</p>
        {digest.bullets.length > 0 && (
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-4">
            {digest.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Week of {formatDate(digest.weekStart)}
          {digest.source === "clerk" && " · Written by Clerk"}
        </p>
      </CardContent>
    </Card>
  );
}

// The Clerk tab's floor: the digest and "Clerk suggests" cards are
// render-on-success, so on a quiet week both are absent — this card keeps
// the tab meaningful by pointing at the surface that always answers.
export function AskClerkCard() {
  return (
    <Card data-testid="card-ask-clerk">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Ask Clerk
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Ask questions about your own invoices, deadlines and filings — Clerk
          answers from your records, with the workings shown. Clerk&apos;s
          summaries and suggested actions appear here when there is something
          worth showing.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/clerk/ask" data-testid="link-ask-clerk">
            Open Ask Clerk
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// Advisory brief (Advise with Clerk, round 49): the firm's monthly
// advisory work product for this client — deterministic evidence-cited
// sections, adviser's note phrased at most once (source says which path).
// Client-scoped exactly like the statement card (SEC-03 is server-side:
// the route pins a client_user to its own party); renders only when the
// firm has generated one.
export function AdvisoryBriefCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
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
  const brief = briefs?.[0];
  if (!isSuccess || !brief) return null;
  return (
    <Card data-testid="advisory-brief">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Your
          adviser's brief
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold" data-testid="text-brief-headline">
          {brief.headline}
        </p>
        <p className="text-sm text-muted-foreground">{brief.note}</p>
        <div className="space-y-2">
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
        </div>
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {statementMonthLabel(brief.monthStart)}
          {brief.source === "clerk" && " · Note written by Clerk"}
        </p>
      </CardContent>
    </Card>
  );
}
