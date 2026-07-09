import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileQuestion } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";

export default function NotFound() {
  usePageTitle("Page not found");
  return (
    <div className="flex items-center justify-center py-16">
      <Card className="w-full max-w-md">
        <CardContent className="py-12 flex flex-col items-center text-center gap-2">
          <FileQuestion className="w-10 h-10 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            We couldn't find that page
          </h1>
          <p className="text-sm text-muted-foreground">
            The link may be out of date, or the page may have moved.
          </p>
          <Button asChild className="mt-2">
            <Link href="/">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
