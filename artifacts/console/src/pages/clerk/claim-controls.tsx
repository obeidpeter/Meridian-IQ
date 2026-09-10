import type {
  ClerkCase,
  useClaimClerkCase,
  useReleaseClerkCase,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { pillClasses } from "@/lib/format";
import { relativeTime, shortActor } from "@/pages/clerk-shared";

// The claim / release controls the two decision forms share (R126 moved the
// markup out of the workspace hook; the hook still hands the forms null when
// no case is selected). A fragment, so the forms' DOM is unchanged.
export function ClaimControls({
  selected,
  claimCase,
  releaseCase,
}: {
  selected: ClerkCase;
  claimCase: ReturnType<typeof useClaimClerkCase>;
  releaseCase: ReturnType<typeof useReleaseClerkCase>;
}) {
  return (
    <>
      {selected.status === "extracted" && !selected.claimedBy && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => claimCase.mutate({ id: selected.id })}
            disabled={claimCase.isPending}
            data-testid="button-claim-case"
          >
            {claimCase.isPending ? "Claiming…" : "Claim for review"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Optional — deciding below works without claiming.
          </p>
        </div>
      )}
      {selected.status === "in_review" && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className={pillClasses("amber")} data-testid="badge-claimed">
            Claimed by {shortActor(selected.claimedBy)} ·{" "}
            {relativeTime(selected.claimedAt)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => releaseCase.mutate({ id: selected.id })}
            disabled={releaseCase.isPending}
            data-testid="button-release-case"
          >
            {releaseCase.isPending ? "Releasing…" : "Release"}
          </Button>
        </div>
      )}
    </>
  );
}
