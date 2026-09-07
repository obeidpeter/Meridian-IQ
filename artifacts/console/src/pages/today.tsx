import { useCallback, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetWorkspaceTodayQueryKey,
  getListWorkItemCommentsQueryKey,
  getListWorkItemsQueryKey,
  useCreateWorkItem,
  useCreateWorkItemComment,
  useGetMe,
  useGetPortfolio,
  useGetWorkspaceToday,
  useListFirmTeam,
  useListWorkItemComments,
  useListWorkItems,
  useUpdateWorkItem,
  type WorkItem,
} from "@workspace/api-client-react";
import {
  TodayWorkspace,
  WorkManagement,
  trackUsabilityEvent,
  type CollaborativeWorkItem,
  type CollaborativeWorkStatus,
  type CreateCollaborativeWorkInput,
} from "@workspace/web-ui";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { Plus } from "lucide-react";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This workspace could not be loaded.";
}

export function Today() {
  usePageTitle("Today");
  const [, navigate] = useLocation();
  const { data, isLoading, error, refetch } = useGetWorkspaceToday(
    { limit: 24 },
    {
      query: {
        queryKey: getGetWorkspaceTodayQueryKey({ limit: 24 }),
        staleTime: 30_000,
      },
    },
  );

  if (isLoading && !data) {
    return (
      <div className="space-y-4" role="status">
        <span className="sr-only">Loading today&apos;s priorities…</span>
        <div className="h-24 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h-28 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }
  if (!data || error) {
    return <QueryError thing="today's workspace" onRetry={() => void refetch()} />;
  }
  return (
    <TodayWorkspace
      eyebrow="Valo Today"
      title="What needs attention"
      description="Deadlines, failed submissions and team work are prioritised from live records."
      summary={data.summary}
      items={data.items}
      setup={data.setup}
      generatedAt={data.generatedAt}
      onOpen={(href, item) => {
        if (item) trackUsabilityEvent("today_item_opened", "today");
        navigate(href);
      }}
      onManageWork={() => navigate("/work")}
      actions={
        <Button onClick={() => navigate("/work?action=new")}>
          <Plus className="size-4" aria-hidden="true" />
          New task
        </Button>
      }
    />
  );
}

function asCollaborative(item: WorkItem): CollaborativeWorkItem {
  return item;
}

export function WorkPage() {
  usePageTitle("Team work");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useListWorkItems({ limit: 100 });
  const comments = useListWorkItemComments(selectedId ?? "", {
    query: {
      queryKey: getListWorkItemCommentsQueryKey(selectedId ?? ""),
      enabled: Boolean(selectedId),
    },
  });
  const { data: portfolio } = useGetPortfolio();
  const { data: team } = useListFirmTeam();
  const create = useCreateWorkItem();
  const update = useUpdateWorkItem();
  const addComment = useCreateWorkItemComment();

  const refreshWork = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: getListWorkItemsQueryKey() });
    await queryClient.invalidateQueries({ queryKey: getGetWorkspaceTodayQueryKey() });
  }, [queryClient]);

  const refreshComments = useCallback(
    async (id: string) => {
      await queryClient.invalidateQueries({
        queryKey: getListWorkItemCommentsQueryKey(id),
      });
    },
    [queryClient],
  );

  return (
    <WorkManagement
      items={(list.data ?? []).map(asCollaborative)}
      comments={comments.data ?? []}
      selectedId={selectedId}
      clients={(portfolio?.clients ?? []).map((client) => ({
        id: client.clientPartyId,
        name: client.legalName,
      }))}
      assignees={(team ?? []).map((member) => ({
        id: member.userId,
        name: member.fullName ?? member.email ?? "Workspace member",
        clientPartyId: member.clientPartyId,
      }))}
      isLoading={list.isLoading}
      commentsLoading={comments.isLoading}
      busy={create.isPending || update.isPending || addComment.isPending}
      error={list.error ? errorMessage(list.error) : null}
      openNewInitially={new URLSearchParams(window.location.search).get("action") === "new"}
      draftStorageKey={
        me?.userId ? `meridianiq:work-draft:${me.userId}` : undefined
      }
      onSelect={setSelectedId}
      onRetry={() => void list.refetch()}
      onCreate={async (input: CreateCollaborativeWorkInput) => {
        const created = await create.mutateAsync({
          data: input,
        });
        setSelectedId(created.id);
        await refreshWork();
        trackUsabilityEvent("work_item_created", "collaboration");
      }}
      onUpdateStatus={async (
        item: CollaborativeWorkItem,
        status: CollaborativeWorkStatus,
      ) => {
        await update.mutateAsync({
          id: item.id,
          data: { version: item.version, status },
        });
        await refreshWork();
        if (status === "done") {
          trackUsabilityEvent("work_item_completed", "collaboration");
        }
      }}
      onUpdateAssignee={async (item, assignedTo) => {
        await update.mutateAsync({
          id: item.id,
          data: { version: item.version, assignedTo },
        });
        await refreshWork();
      }}
      onComment={async (item, body, clientRequestId) => {
        await addComment.mutateAsync({
          id: item.id,
          data: { clientRequestId, body },
        });
        await refreshComments(item.id);
        trackUsabilityEvent("collaboration_comment_added", "collaboration");
      }}
      onOpenLinkedRecord={navigate}
    />
  );
}
