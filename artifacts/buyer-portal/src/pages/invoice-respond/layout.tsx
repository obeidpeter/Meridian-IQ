import { Link } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, FileQuestion } from "lucide-react";

export function BackLink() {
  return (
    <Link
      href="/confirmations"
      className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      data-testid="link-back"
    >
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to confirmations
    </Link>
  );
}

export function RespondSkeleton() {
  return (
    <div className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-72 max-w-full mt-2" />
        </div>
        <Skeleton className="h-7 w-32 rounded-full" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-24" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-64" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>
    </div>
  );
}

export function UnknownInvoiceCard() {
  return (
    <div className="space-y-4">
      <BackLink />
      <Card data-testid="card-unknown-invoice">
        <CardContent className="py-12 flex flex-col items-center text-center gap-2">
          <FileQuestion
            className="w-10 h-10 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="font-semibold" data-testid="text-error">
            We couldn't find this invoice
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            It may not be addressed to your organization, or the link may be out
            of date. Your confirmation queue lists every invoice you can act on.
          </p>
          <Button asChild variant="outline" data-testid="button-back-to-queue">
            <Link href="/confirmations">Back to confirmations</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
