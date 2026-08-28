import { useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { ActivityCenter, useOperationJournal } from "@workspace/web-ui";
import { PageHeader } from "@/components/page-header";
import { usePageTitle } from "@/hooks/use-page-title";

export function ActivityPage() {
  usePageTitle("Activity");
  const { data: me } = useGetMe();
  const [, navigate] = useLocation();
  const journal = useOperationJournal(
    me ? `meridianiq:operations:${me.userId}` : null,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Track recent imports, submissions, and Clerk work on this device. Open an item to verify or continue it."
      />
      <ActivityCenter
        operations={journal.operations}
        onOpen={navigate}
        onDismiss={journal.dismiss}
        onClearCompleted={journal.clearCompleted}
      />
    </div>
  );
}
