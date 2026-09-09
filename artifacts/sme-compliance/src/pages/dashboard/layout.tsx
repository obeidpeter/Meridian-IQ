import { type ComplianceDeadline } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { Clock, CalendarCheck } from "lucide-react";
import { Link } from "wouter";
import {
  formatLagosDate,
  severityLabel,
  severityBadgeClasses,
} from "@/lib/format";

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// Next statutory deadline — mounted on Today AND on the Compliance tab:
// the Compliance tab's count chip counts upcoming deadlines, so the tab
// must show the deadline itself, not only the render-on-success advisory
// cards (which are all absent on a fresh or healthy book).
export function NextDeadlineCard({
  deadline,
}: {
  deadline: ComplianceDeadline | null | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span
            className="mi-card-icon"
            data-tone={
              deadline?.severity === "critical" ? "critical" : undefined
            }
          >
            <Clock aria-hidden="true" />
          </span>
          Next deadline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {deadline ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{deadline.title}</span>
              <span className={severityBadgeClasses(deadline.severity)}>
                {severityLabel(deadline.severity)}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {formatLagosDate(deadline.dueDate)}
            </p>
            <Link
              href="/calendar"
              className="text-primary text-sm mt-2 hover:underline"
            >
              View calendar
            </Link>
          </div>
        ) : (
          <EmptyState
            icon={CalendarCheck}
            title="No upcoming deadlines"
            description="Nothing needs compliance attention right now — statutory deadlines appear here as they approach."
            className="px-0 py-4"
            testId="text-no-deadline"
          >
            <Link
              href="/calendar"
              className="text-primary text-sm hover:underline"
              data-testid="link-deadline-calendar"
            >
              View calendar
            </Link>
          </EmptyState>
        )}
      </CardContent>
    </Card>
  );
}
