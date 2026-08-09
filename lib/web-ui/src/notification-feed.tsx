import type { ReactNode } from "react";

/** One row of the bell feed, pre-formatted by the app: the channel badge
 * vocabulary lives in @workspace/format and routing is app-specific, so the
 * page supplies display strings and an optional href and this component
 * owns only the shared list markup. */
export type NotificationFeedRow = {
  id: string;
  title: string;
  read: boolean;
  channelBadgeClass: string;
  channelLabel: string;
  timeLabel: string;
  timeTitle?: string;
  status: string;
  href?: string | null;
};

export function NotificationFeed({
  rows,
  emptyTitle,
  emptyHint,
  unreadDotClass = "bg-teal-600",
  renderLink,
}: {
  rows: NotificationFeedRow[];
  emptyTitle: string;
  emptyHint: string;
  /** Unread-marker colour — the buyer portal runs cyan, the rest teal. */
  unreadDotClass?: string;
  /** Wraps a row in the app's router link; rows without an href (or when
   * this is omitted) render as plain rows. */
  renderLink?: (href: string, children: ReactNode, key: string) => ReactNode;
}) {
  return (
    <section className="overflow-hidden border-y border-slate-200 bg-white">
      {rows.length === 0 ? (
        <div className="px-5 py-16 text-center">
          <p className="font-bold text-slate-900">{emptyTitle}</p>
          <p className="mt-1 text-sm text-slate-500">{emptyHint}</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200">
          {rows.map((row) => {
            const content = (
              <>
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    row.read ? "bg-slate-200" : unreadDotClass
                  }`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm ${
                      row.read
                        ? "font-medium text-slate-700"
                        : "font-bold text-slate-950"
                    }`}
                  >
                    {row.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className={row.channelBadgeClass}>
                      {row.channelLabel}
                    </span>
                    <span title={row.timeTitle}>{row.timeLabel}</span>
                    <span>{row.status}</span>
                  </span>
                </span>
              </>
            );
            return row.href && renderLink ? (
              renderLink(row.href, content, row.id)
            ) : (
              <div key={row.id} className="flex items-start gap-3 px-5 py-4">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
