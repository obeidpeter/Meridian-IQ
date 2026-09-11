import type { Dispatch, SetStateAction } from "react";
import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { ClaimPanel } from "./claim-panel";
import { formatDate, type RoomAction } from "./helpers";
import { PaymentPanel } from "./payment-panel";
import { ResponsePanel } from "./response-panel";
import { VerifyPanel } from "./verify-panel";

export function RoomActions({
  detail,
  pending,
  setPending,
  setDetail,
}: {
  detail: InvoiceRoomDetail;
  pending: RoomAction | null;
  setPending: Dispatch<SetStateAction<RoomAction | null>>;
  setDetail: Dispatch<SetStateAction<InvoiceRoomDetail | null>>;
}) {
  return (
    <aside
      className="space-y-5 lg:sticky lg:top-6"
      aria-label="Invoice actions"
    >
      {!detail.room.identityVerified ? (
        <VerifyPanel
          detail={detail}
          pending={pending}
          setPending={setPending}
          onVerified={setDetail}
        />
      ) : (
        <div
          className="flex items-start gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
        >
          <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-extrabold">Contact verified</span>
            <br />
            You can now use the invoice actions available to you.
          </span>
        </div>
      )}
      {detail.room.identityVerified && (
        <ResponsePanel
          detail={detail}
          pending={pending}
          setPending={setPending}
          onChange={setDetail}
        />
      )}
      {detail.room.identityVerified && (
        <PaymentPanel
          detail={detail}
          pending={pending}
          setPending={setPending}
          onChange={setDetail}
        />
      )}
      {detail.room.identityVerified && (
        <ClaimPanel detail={detail} pending={pending} setPending={setPending} />
      )}
      <section
        className="border border-slate-200 bg-white p-5 text-sm text-slate-600"
        aria-labelledby="security-heading"
      >
        <h2
          id="security-heading"
          className="flex items-center gap-2 font-extrabold text-slate-900"
        >
          <LockKeyhole className="size-4 text-teal-700" aria-hidden="true" />{" "}
          Link security
        </h2>
        <p className="mt-2 leading-6">
          Access through this link expires {formatDate(detail.room.expiresAt)}.
          Valo never asks for your banking password or one-time bank PIN.
        </p>
      </section>
    </aside>
  );
}
