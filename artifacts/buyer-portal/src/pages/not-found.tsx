import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";

export default function NotFound() {
  usePageTitle("Page not found");
  return (
    <div className="w-full flex items-center justify-center py-16">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-start gap-3">
            <AlertCircle
              className="h-8 w-8 text-destructive shrink-0"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">
                We couldn't find that page
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                The link may be out of date, or the page may have moved.
              </p>
            </div>
          </div>
          <Button asChild data-testid="link-home">
            <Link href="/">Back to confirmations</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
