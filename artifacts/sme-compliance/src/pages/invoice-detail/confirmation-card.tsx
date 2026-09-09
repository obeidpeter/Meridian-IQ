import { type Confirmation, type Invoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, MailCheck } from "lucide-react";
import {
  formatDateTime,
  humanize,
  pillClasses,
  confirmationLabel,
  confirmationBadgeClasses,
} from "@/lib/format";

// Buyer-confirmation card: request button plus the confirmation timeline. The
// parent keeps the mutation and the can-request lifecycle predicate.
export function ConfirmationCard({
  invoice,
  timeline,
  featureDisabled,
  canRequest,
  onRequest,
  isPending,
}: {
  invoice: Invoice;
  timeline: Confirmation[];
  featureDisabled: boolean;
  canRequest: boolean;
  onRequest: () => void;
  isPending: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <MailCheck className="w-4 h-4" aria-hidden="true" /> Buyer
          confirmation
        </CardTitle>
        {canRequest && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRequest}
            disabled={isPending}
          >
            <Send className="w-4 h-4 mr-2" aria-hidden="true" />
            {isPending ? "Requesting…" : "Request confirmation"}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {featureDisabled ? (
          <p className="text-sm text-muted-foreground">
            Buyer confirmations are not yet switched on for your business. Ask
            your accounting firm about switching it on.
          </p>
        ) : timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No confirmation activity yet.
            {invoice.status === "stamped"
              ? " Request a confirmation so your customer acknowledges this invoice."
              : " Confirmations open up once the invoice is stamped."}
          </p>
        ) : (
          <div>
            {timeline.map((c, i) => (
              <div key={c.id} className="relative pl-6 pb-4 last:pb-0">
                {i < timeline.length - 1 && (
                  <span className="absolute left-[5px] top-4 bottom-0 w-px bg-border" />
                )}
                <span
                  className={`absolute left-0 top-1.5 w-3 h-3 rounded-full border-2 border-background ${
                    c.state === "confirmed"
                      ? "bg-emerald-500"
                      : c.state === "rejected"
                        ? "bg-red-500"
                        : c.state === "queried"
                          ? "bg-blue-500"
                          : "bg-amber-500"
                  }`}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={confirmationBadgeClasses(c.state)}>
                    {confirmationLabel(c.state)}
                  </span>
                  {c.method && (
                    <span className="text-xs text-muted-foreground">
                      via {humanize(c.method)}
                    </span>
                  )}
                  {c.noSetOff && (
                    <span className={pillClasses("slate")}>No set-off</span>
                  )}
                </div>
                {c.note && (
                  <p className="text-sm text-muted-foreground mt-1">{c.note}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDateTime(c.createdAt)}
                  {c.confirmingUserId && (
                    <>
                      {" "}
                      · by{" "}
                      <span className="font-mono">{c.confirmingUserId}</span>
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
