// The public Invoice Room page (R126 split the 1,572-line file into this
// shell, one module per action panel and page section, the chrome and the
// pure helpers). main.tsx and App.tsx keep lazily importing "./InvoiceRoom"
// for its default export. The token exchange (which rewrites the URL hash)
// and the robots meta effect stay here, on the page's own mount.

import { useEffect, useState } from "react";
import {
  exchangeInvoiceRoomToken,
  getPublicInvoiceRoom,
} from "@workspace/api-client-react";
import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { ActivityTimeline } from "@/invoice-room/activity-timeline";
import { EvidenceSection } from "@/invoice-room/evidence-section";
import { readAndClearRoomToken, type RoomAction } from "@/invoice-room/helpers";
import { InvoiceDocument } from "@/invoice-room/invoice-document";
import { RoomActions } from "@/invoice-room/room-actions";
import { RoomHero } from "@/invoice-room/room-hero";
import {
  InvoiceRoomShell,
  LoadingRoom,
  UnavailableRoom,
} from "@/invoice-room/shell";

export default function InvoiceRoom() {
  const [detail, setDetail] = useState<InvoiceRoomDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pending, setPending] = useState<RoomAction | null>("exchange");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>(
      'meta[name="robots"]',
    );
    const previous = existing?.getAttribute("content") ?? null;
    const meta = existing ?? document.createElement("meta");
    if (!existing) {
      meta.name = "robots";
      document.head.append(meta);
    }
    meta.content = "noindex, nofollow, noarchive";

    return () => {
      if (!existing) {
        meta.remove();
      } else if (previous === null) {
        meta.removeAttribute("content");
      } else {
        meta.content = previous;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    const token = readAndClearRoomToken();
    setLoading(true);
    setLoadError(null);
    setPending("exchange");
    const load = token
      ? exchangeInvoiceRoomToken({ token })
      : getPublicInvoiceRoom();
    void load
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((error) => {
        if (active) setLoadError(error);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setPending(null);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  if (loading) return <LoadingRoom />;
  if (!detail || loadError)
    return (
      <UnavailableRoom
        error={loadError}
        onRetry={() => setReloadNonce((value) => value + 1)}
      />
    );

  return (
    <InvoiceRoomShell>
      <main id="invoice-room-main" tabIndex={-1} className="focus:outline-none">
        <RoomHero detail={detail} />

        <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 sm:py-10">
          <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start">
            <div className="min-w-0 space-y-7">
              <InvoiceDocument detail={detail} />

              <EvidenceSection detail={detail} />

              <ActivityTimeline detail={detail} />
            </div>

            <RoomActions
              detail={detail}
              pending={pending}
              setPending={setPending}
              setDetail={setDetail}
            />
          </div>
        </div>
      </main>
    </InvoiceRoomShell>
  );
}
