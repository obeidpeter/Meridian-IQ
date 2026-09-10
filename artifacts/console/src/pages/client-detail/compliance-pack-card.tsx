import { useState } from "react";
import {
  getGetCompliancePackUrl,
  useNotifyCompliancePack,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, FileText, Send } from "lucide-react";
import { triggerDownload } from "@/lib/download";
import { serverErrorToast } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { currentMonthStart, packPdfFilename } from "./helpers";

// The monthly compliance pack card (see helpers.ts for the pack's naming and
// month-default kernels).

export function CompliancePackCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const [packMonth, setPackMonth] = useState(() => currentMonthStart());
  const notify = useNotifyCompliancePack();

  const handleNotify = () => {
    notify.mutate(
      { data: { clientPartyId, month: packMonth } },
      {
        onSuccess: () =>
          toast({
            title:
              "Client notified — delivery respects their consent and channel preferences.",
          }),
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not notify the client",
            fallback: "Try again.",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-compliance-pack">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <FileText aria-hidden="true" />
          </span>
          Monthly compliance pack
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          One PDF for the month: cover note, document register, receivables,
          payables, VAT position and deadlines.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="pack-month">Month</Label>
          <Input
            id="pack-month"
            type="month"
            className="w-44"
            value={packMonth.slice(0, 7)}
            onChange={(e) =>
              setPackMonth(
                e.target.value ? `${e.target.value}-01` : currentMonthStart(),
              )
            }
            data-testid="input-pack-month"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              triggerDownload(
                getGetCompliancePackUrl({ clientPartyId, month: packMonth }),
                packPdfFilename(packMonth),
              )
            }
            data-testid="button-download-pack"
          >
            <Download className="w-4 h-4 mr-1" aria-hidden="true" /> Download
            pack (PDF)
          </Button>
          <Button
            variant="outline"
            onClick={handleNotify}
            disabled={notify.isPending}
            data-testid="button-notify-pack"
          >
            <Send className="w-4 h-4 mr-1" aria-hidden="true" />
            {notify.isPending ? "Notifying…" : "Notify client"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The notification is pointer-only — the client signs in to fetch the
          pack; none of their numbers ride the message.
        </p>
      </CardContent>
    </Card>
  );
}
