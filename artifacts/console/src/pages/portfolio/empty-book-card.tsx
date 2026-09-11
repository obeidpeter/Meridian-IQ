import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Plus, Upload, Users } from "lucide-react";

// First-run empty state: the portfolio query succeeded but the book is
// empty, so show the way in (single intake, bulk import, the onboarding
// pipeline) instead of a wall of zeros.
export function EmptyBookCard({
  canImport,
  onAddClient,
}: {
  canImport: boolean;
  onAddClient: () => void;
}) {
  return (
    <Card className="shadow-sm">
      <EmptyState
        icon={Users}
        title="Add your first client"
        description={
          <span className="block max-w-md">
            Clients appear here once they're on the platform. Add your first
            client to start tracking risk, deadlines and receivables, or track
            prospects through onboarding.
          </span>
        }
      >
        <div className="flex flex-wrap justify-center gap-2 mt-2">
          <Button onClick={onAddClient} data-testid="button-empty-add-client">
            <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
            Add your first client
          </Button>
          {canImport && (
            <Button variant="outline" asChild data-testid="button-empty-import">
              <Link href="/clients/import">
                <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                Bulk import clients
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild data-testid="button-empty-pipeline">
            <Link href="/pipeline">Open onboarding</Link>
          </Button>
        </div>
      </EmptyState>
    </Card>
  );
}
