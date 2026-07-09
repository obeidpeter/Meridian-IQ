import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";

export default function NotFound() {
  usePageTitle("Page not found");
  return (
    <div className="flex items-center justify-center py-16">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <AlertCircle
              className="h-8 w-8 text-destructive shrink-0"
              aria-hidden="true"
            />
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              We couldn't find that page
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            The link may be out of date, or the page may have moved.
          </p>
          <Button asChild data-testid="button-back-home">
            <Link href="/">Back to the console</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
