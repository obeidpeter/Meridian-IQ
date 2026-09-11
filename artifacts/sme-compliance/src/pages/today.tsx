import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetWorkspaceTodayQueryKey,
  getListWorkItemCommentsQueryKey,
  getListWorkItemsQueryKey,
  getListWorkItemsPageQueryKey,
  listWorkItemsPage,
  useCreateWorkItem,
  useCreateWorkItemComment,
  useGetMe,
  useGetWorkspaceToday,
  useListWorkItemComments,
  useUpdateWorkItem,
  type Me,
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
import { Plus, RefreshCw } from "lucide-react";

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "This workspace could not be loaded.";
}

export function Today() {
  usePageTitle("Today");
  const [, navigate] = useLocation();
  const { data, isLoading, isFetching, error, refetch } = useGetWorkspaceToday(
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
  if (!data) {
    return (
      <QueryError thing="today's workspace" onRetry={() => void refetch()} />
    );
  }
  return (
    <>
      {error ? (
        <div className="mi-collaboration__error" role="alert">
          <span>
            Today's workspace could not be refreshed. Showing the last loaded
            priorities.
          </span>
          <Button variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : null}
      {/* R113: the setup checklist is confirmed only by a successful read.
          After a failed refresh the cached queue stays useful, but the
          checklist reports unavailable instead of a stale percentage. */}
      <TodayWorkspace
        eyebrow="Valo Today"
        title="Your business today"
        description="See which invoices, legal deadlines and team tasks need attention first."
        summary={data.summary}
        items={data.items}
        setup={data.setup}
        setupError={error ? errorMessage(error) : null}
        setupLoading={Boolean(error) && isFetching}
        onRetrySetup={() => void refetch()}
        generatedAt={data.generatedAt}
        onOpen={(href, item) => {
          if (item) trackUsabilityEvent("today_item_opened", "today");
          navigate(href);
        }}
        onManageWork={() => navigate("/work")}
        actions={
          <Button onClick={() => navigate("/work?action=new")}>
            <Plus className="size-4" aria-hidden="true" />
            Ask or assign
          </Button>
        }
      />
    </>
  );
}

export function WorkPage() {
  const { data: me } = useGetMe();
  const scope = JSON.stringify([
    me?.userId,
    me?.firmId,
    me?.clientPartyId,
    me?.role,
    me?.capabilities,
  ]);
  return <ScopedWorkPage key={scope} me={me} />;
}

function ScopedWorkPage({ me }: { me: Me | undefined }) {
  usePageTitle("Team work");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createdSelection, setCreatedSelection] = useState<{
    item: WorkItem;
    listUpdatedAt: number;
  } | null>(null);
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setCreatedSelection((current) =>
      current?.item.id === id ? current : null,
    );
  }, []);
  const [view, setView] = useState<"active" | "done" | "all">("active");
  const list = useInfiniteQuery({
    queryKey: [
      ...getListWorkItemsPageQueryKey({ view, limit: 50 }),
      { userId: me?.userId, firmId: me?.firmId, clientId: me?.clientPartyId },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listWorkItemsPage({ view, limit: 50, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(me),
  });
  // Memoised on the query data (R114): a fresh array every render made the
  // selection effect below and the shared component's filter memo run on
  // every render instead of on real change.
  const items = useMemo(
    () =>
      Array.from(
        new Map(
          (list.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ),
    [list.data],
  );
  const comments = useListWorkItemComments(selectedId ?? "", {
    query: {
      queryKey: [
        ...getListWorkItemCommentsQueryKey(selectedId ?? ""),
        { userId: me?.userId, firmId: me?.firmId, clientId: me?.clientPartyId },
      ],
      enabled: Boolean(selectedId),
    },
  });
  const create = useCreateWorkItem();
  const update = useUpdateWorkItem();
  const addComment = useCreateWorkItemComment();

  const clearUnavailableSelection = useCallback(
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        [401, 403, 404].includes(Number(error.status))
      )
        select(null);
    },
    [select],
  );

  useEffect(() => {
    if (!createdSelection) return;
    // Once the list includes the task, future removals must use list evidence.
    if (items.some((item) => item.id === createdSelection.item.id)) {
      setCreatedSelection(null);
    } else if (
      !list.isFetching &&
      !list.error &&
      !list.hasNextPage &&
      list.dataUpdatedAt > createdSelection.listUpdatedAt
    ) {
      select(null);
    }
    clearUnavailableSelection(comments.error);
    clearUnavailableSelection(list.error);
  }, [
    createdSelection,
    items,
    list.isFetching,
    list.error,
    list.hasNextPage,
    list.dataUpdatedAt,
    comments.error,
    select,
    clearUnavailableSelection,
  ]);

  const refreshWork = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: getListWorkItemsPageQueryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: getListWorkItemsQueryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: getGetWorkspaceTodayQueryKey(),
    });
  }, [queryClient]);

  return (
    <WorkManagement
      items={items}
      comments={comments.data ?? []}
      selectedId={selectedId}
      selectedItem={createdSelection?.item}
      assignees={
        me?.userId
          ? [
              {
                id: me.userId,
                name: me.fullName ?? me.email ?? "Me",
                clientPartyId: me.clientPartyId,
              },
            ]
          : []
      }
      isLoading={list.isLoading}
      commentsLoading={comments.isLoading}
      commentsError={comments.error ? errorMessage(comments.error) : null}
      onRetryComments={() => void comments.refetch()}
      commentDraftStorageKey={
        me?.userId
          ? `meridianiq:work-comment:${me.userId}:${me.firmId ?? "none"}:${me.clientPartyId ?? "firm"}`
          : undefined
      }
      pageView={view}
      onPageViewChange={(next) => {
        select(null);
        setView(next);
      }}
      // The newest page's total, so rows that land while paging are counted (R114).
      total={list.data?.pages.at(-1)?.total}
      hasMore={list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      busy={create.isPending || update.isPending || addComment.isPending}
      error={list.error ? errorMessage(list.error) : null}
      openNewInitially={
        new URLSearchParams(window.location.search).get("action") === "new"
      }
      // Scoped like the comment key (R116): one user can belong to more than
      // one workspace, and a draft belongs to the one it was written in.
      draftStorageKey={
        me?.userId
          ? `meridianiq:work-draft:${me.userId}:${me.firmId ?? "none"}:${me.clientPartyId ?? "firm"}`
          : undefined
      }
      legacyDraftStorageKey={
        me?.userId ? `meridianiq:work-draft:${me.userId}` : undefined
      }
      onSelect={select}
      onRetry={() => void list.refetch()}
      onCreate={async (input: CreateCollaborativeWorkInput) => {
        const created = await create.mutateAsync({
          data: input,
        });
        setCreatedSelection({ item: created, listUpdatedAt: Date.now() });
        setSelectedId(created.id);
        setView(created.status === "done" ? "done" : "active");
        await refreshWork();
        trackUsabilityEvent("work_item_created", "collaboration");
      }}
      onUpdateStatus={async (
        item: CollaborativeWorkItem,
        status: CollaborativeWorkStatus,
      ) => {
        const updated = await update
          .mutateAsync({
            id: item.id,
            data: { version: item.version, status },
          })
          .catch((error) => {
            clearUnavailableSelection(error);
            throw error;
          });
        setCreatedSelection((current) =>
          current?.item.id === updated.id
            ? { ...current, item: updated }
            : current,
        );
        await refreshWork();
        if (status === "done") {
          trackUsabilityEvent("work_item_completed", "collaboration");
        }
      }}
      onComment={async (item, body, clientRequestId) => {
        await addComment
          .mutateAsync({
            id: item.id,
            data: { clientRequestId, body },
          })
          .catch((error) => {
            clearUnavailableSelection(error);
            throw error;
          });
        await queryClient.invalidateQueries({
          queryKey: getListWorkItemCommentsQueryKey(item.id),
        });
        trackUsabilityEvent("collaboration_comment_added", "collaboration");
      }}
      onOpenLinkedRecord={navigate}
    />
  );
}
