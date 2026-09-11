import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { Clock3 } from "lucide-react";
import { EVENT_LABEL, formatDateTime } from "./helpers";

export function ActivityTimeline({ detail }: { detail: InvoiceRoomDetail }) {
  return (
    <section
      className="border border-slate-200 bg-white p-5 sm:p-6"
      aria-labelledby="activity-heading"
    >
      <div className="flex items-center gap-3">
        <Clock3 className="size-5 text-teal-700" aria-hidden="true" />
        <div>
          <h2 id="activity-heading" className="font-extrabold">
            Invoice history
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Recorded actions and their dates and times
          </p>
        </div>
      </div>
      {detail.timeline.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">
          No activity has been recorded yet.
        </p>
      ) : (
        <ol className="mt-5 space-y-0">
          {[...detail.timeline].reverse().map((event, index) => (
            <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
              {index < detail.timeline.length - 1 && (
                <span
                  className="absolute left-[7px] top-4 h-full w-px bg-slate-200"
                  aria-hidden="true"
                />
              )}
              <span
                className="relative mt-1 size-4 shrink-0 rounded-full border-4 border-white bg-teal-600 ring-1 ring-teal-200"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-bold">
                  {EVENT_LABEL[event.kind] ?? event.kind.replaceAll("_", " ")}
                </p>
                <time
                  dateTime={event.createdAt}
                  className="mt-1 block text-xs text-slate-500"
                >
                  {formatDateTime(event.createdAt)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
