import { useLocation } from "wouter";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import {
  ActivityCenter,
  operationSessionKey,
  useSessionOperations,
  useOperationNavigation,
} from "@workspace/web-ui";
import { PageHeader } from "@/components/page-header";
import { usePageTitle } from "@/hooks/use-page-title";

export function ActivityPage() {
  usePageTitle("Activity");
  const { data: me } = useGetMe();
  const [, navigate] = useLocation();
  const openOperation = useOperationNavigation("app", navigate);
  const journal = useSessionOperations(me, customFetch);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Track recent imports, submissions, and Clerk work on this device. Open an item to verify or continue it."
      />
      <ActivityCenter
        key={operationSessionKey(me)}
        operations={journal.operations}
        syncState={journal.syncState}
        onRefresh={journal.refresh}
        onRecover={journal.recover}
        onOpen={openOperation}
        onDismiss={journal.dismiss}
        onClearCompleted={journal.clearCompleted}
      />
    </div>
  );
}
