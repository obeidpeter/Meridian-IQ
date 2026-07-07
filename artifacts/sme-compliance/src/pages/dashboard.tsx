import { useGetMe, useGetDashboardSummary, useGetComplianceCalendar, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle, Clock, FileText, Activity } from "lucide-react";
import { Link } from "wouter";

export function Dashboard() {
  const { data: me } = useGetMe();
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary(
    { clientPartyId: me?.clientPartyId || "" },
    { query: { enabled: !!me?.clientPartyId, queryKey: getGetDashboardSummaryQueryKey({ clientPartyId: me?.clientPartyId || "" }) } }
  );

  if (loadingSummary) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Compliance Overview</h1>
          <p className="text-muted-foreground">Stay ahead of your filing deadlines.</p>
        </div>
        <Link href="/invoices/new" className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2">
          New Invoice
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Invoices</CardTitle>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.pendingCount || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting stamp</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Stamped & Valid</CardTitle>
            <CheckCircle className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.stampedCount || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">{summary?.stampedValue || "₦0.00"} total value</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Drafts</CardTitle>
            <FileText className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.draftCount || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Needs completion</p>
          </CardContent>
        </Card>

        <Card className={summary?.atRiskCount ? "border-destructive/50 bg-destructive/5" : ""}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">At Risk</CardTitle>
            <AlertTriangle className={`w-4 h-4 ${summary?.atRiskCount ? "text-destructive" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.atRiskCount || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Needs attention</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" /> Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary?.recentActivity && summary.recentActivity.length > 0 ? (
              <div className="space-y-4">
                {summary.recentActivity.map((activity) => (
                  <div key={activity.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{activity.label}</p>
                      <p className="text-xs text-muted-foreground">{new Date(activity.at).toLocaleDateString()}</p>
                    </div>
                    {activity.status && <Badge variant="outline">{activity.status}</Badge>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4">No recent activity</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5" /> Next Deadline
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary?.nextDeadline ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{summary.nextDeadline.title}</span>
                  <Badge variant={summary.nextDeadline.severity === "critical" ? "destructive" : "secondary"}>
                    {summary.nextDeadline.severity}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{new Date(summary.nextDeadline.dueDate).toLocaleDateString()}</p>
                <Link href="/calendar" className="text-primary text-sm mt-2 hover:underline">View Calendar</Link>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4">No upcoming deadlines</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
