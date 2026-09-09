import {
  useListClientStatements,
  getListClientStatementsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarCheck } from "lucide-react";
import { statementMonthLabel } from "./helpers";

// Per-client monthly statement (idea #5): the newest CLOSED month's summary
// for this client, generated server-side on the opt-in sweep. Client-scoped
// (clerk.capture, the client's own party), read-only, renders only on
// success — no statement yet or any error means no card at all.
export function ClientStatementCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: statements, isSuccess } = useListClientStatements(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListClientStatementsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  const statement = statements?.[0];
  if (!isSuccess || !statement) return null;
  return (
    <Card data-testid="client-statement">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Your
          compliance month
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold">{statement.headline}</p>
        {statement.bullets.length > 0 && (
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-4">
            {statement.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {statementMonthLabel(statement.monthStart)}
          {statement.source === "clerk" && " · Written by Clerk"}
        </p>
      </CardContent>
    </Card>
  );
}
