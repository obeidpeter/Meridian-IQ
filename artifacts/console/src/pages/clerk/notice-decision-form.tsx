import { type ReactNode } from "react";
import {
  useDecideNoticeCase,
  type Firm,
  type Party,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CatalogueSelect } from "@/components/catalogue-select";
import {
  type NoticeApproveForm,
  authorityLabel,
  noticeApproveDisabled,
  noticeDecisionFromForm,
  noticeTypeLabel,
  taxTypeLabel,
} from "@/pages/clerk-shared";
import { AUTHORITIES, NOTICE_TYPES, TAX_TYPES } from "./constants";
import { FirmSelect, PartySelect } from "./selects";

export function NoticeDecisionForm({
  noticeForm,
  setNoticeForm,
  reason,
  setReason,
  firms,
  parties,
  claimControls,
  caseId,
  decideNotice,
}: {
  noticeForm: NoticeApproveForm;
  setNoticeForm: (form: NoticeApproveForm) => void;
  reason: string;
  setReason: (reason: string) => void;
  firms: Firm[] | undefined;
  parties: Party[] | undefined;
  claimControls: ReactNode;
  caseId: string;
  decideNotice: ReturnType<typeof useDecideNoticeCase>;
}) {
  return (
    <div className="border-t pt-4 space-y-3">
      <p className="text-sm font-medium">
        Review and approve — records a response obligation only
      </p>
      {claimControls}
      <div className="grid sm:grid-cols-2 gap-3">
        <FirmSelect
          firms={firms}
          value={noticeForm.firmId}
          onChange={(v) => setNoticeForm({ ...noticeForm, firmId: v })}
          testId="select-notice-firm"
        />
        <PartySelect
          label="Client party"
          placeholder="Choose client"
          parties={parties}
          value={noticeForm.clientPartyId}
          onChange={(v) =>
            setNoticeForm({
              ...noticeForm,
              clientPartyId: v,
            })
          }
          testId="select-notice-client"
        />
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <CatalogueSelect
          label="Notice type"
          value={noticeForm.noticeType}
          onValueChange={(v) =>
            setNoticeForm({
              ...noticeForm,
              noticeType: v as NoticeApproveForm["noticeType"],
            })
          }
          options={NOTICE_TYPES}
          labelFn={noticeTypeLabel}
          placeholder="Choose type"
          testId="select-notice-type"
        />
        <CatalogueSelect
          label="Authority"
          value={noticeForm.authority}
          onValueChange={(v) =>
            setNoticeForm({
              ...noticeForm,
              authority: v as NoticeApproveForm["authority"],
            })
          }
          options={AUTHORITIES}
          labelFn={authorityLabel}
          placeholder="Choose authority"
          testId="select-notice-authority"
        />
        <CatalogueSelect
          label="Tax type (optional)"
          value={noticeForm.taxType}
          onValueChange={(v) =>
            setNoticeForm({
              ...noticeForm,
              taxType: v as NoticeApproveForm["taxType"],
            })
          }
          options={TAX_TYPES}
          labelFn={taxTypeLabel}
          placeholder="Optional"
          testId="select-notice-tax-type"
        />
      </div>
      <div className="grid sm:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ntc-reference">Reference</Label>
          <Input
            id="ntc-reference"
            value={noticeForm.reference}
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                reference: e.target.value,
              })
            }
            data-testid="input-notice-reference"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ntc-period">Period</Label>
          <Input
            id="ntc-period"
            value={noticeForm.period}
            placeholder="e.g. 2026-Q1"
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                period: e.target.value,
              })
            }
            data-testid="input-notice-period"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ntc-amount">Amount</Label>
          <Input
            id="ntc-amount"
            value={noticeForm.amount}
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                amount: e.target.value,
              })
            }
            data-testid="input-notice-amount"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ntc-currency">Currency</Label>
          <Input
            id="ntc-currency"
            value={noticeForm.currency}
            placeholder="NGN"
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                currency: e.target.value,
              })
            }
            data-testid="input-notice-currency"
          />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ntc-issue">Issue date</Label>
          <Input
            id="ntc-issue"
            type="date"
            value={noticeForm.issueDate}
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                issueDate: e.target.value,
              })
            }
            data-testid="input-notice-issue-date"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ntc-due">Response due date</Label>
          <Input
            id="ntc-due"
            type="date"
            value={noticeForm.responseDueDate}
            onChange={(e) =>
              setNoticeForm({
                ...noticeForm,
                responseDueDate: e.target.value,
              })
            }
            data-testid="input-notice-due-date"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ntc-notes">Notes</Label>
        <Textarea
          id="ntc-notes"
          value={noticeForm.notes}
          onChange={(e) =>
            setNoticeForm({
              ...noticeForm,
              notes: e.target.value,
            })
          }
          rows={2}
          data-testid="input-notice-notes"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ntc-reason">
          Reason (optional, kept with the decision)
        </Label>
        <Textarea
          id="ntc-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          data-testid="input-notice-reason"
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button
          onClick={() =>
            decideNotice.mutate({
              id: caseId,
              data: noticeDecisionFromForm(noticeForm, reason),
            })
          }
          disabled={noticeApproveDisabled(noticeForm) || decideNotice.isPending}
          data-testid="button-approve-notice"
        >
          Approve — record obligation
        </Button>
        <Button
          variant="destructive"
          onClick={() =>
            decideNotice.mutate({
              id: caseId,
              data: {
                action: "reject",
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
            })
          }
          disabled={decideNotice.isPending}
          data-testid="button-reject-notice"
        >
          Reject
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            decideNotice.mutate({
              id: caseId,
              data: {
                action: "escalate",
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
            })
          }
          disabled={decideNotice.isPending}
          data-testid="button-escalate-notice"
        >
          Escalate
        </Button>
      </div>
    </div>
  );
}

// ---- The fast-lane bulk-approve dialog --------------------------------------
// The dialog is explicit about scope: only fast-lane cases (clean extraction,
// clear pre-flight, confident critical fields) are touched, every approval
// creates a DRAFT invoice only, and the server re-checks each case —
// anything that no longer qualifies is skipped and left exactly as it was.
// All state (open/report/labels/candidates) stays in ClerkWorkspace, where
// the live queue drives it.
