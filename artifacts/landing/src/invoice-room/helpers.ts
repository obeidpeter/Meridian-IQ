import type {
  InvoiceRoomConfirmationState,
  InvoiceRoomDetail,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  XCircle,
} from "lucide-react";
import { serverErrorFrom } from "@/lib/errors";

export type RoomAction =
  | "exchange"
  | "verify-send"
  | "verify-code"
  | "respond"
  | "report-payment"
  | "payment-link"
  | "claim";

export type ResponseState = "confirmed" | "queried" | "rejected";

export const RESPONSE_LABEL: Record<InvoiceRoomConfirmationState, string> = {
  requested: "Response requested",
  confirmed: "Confirmed",
  queried: "Query raised",
  rejected: "Rejected",
};

export const EVENT_LABEL: Record<string, string> = {
  created: "Secure room created",
  opened: "Invoice opened",
  delivery_sent: "Secure link delivered",
  identity_verified: "Buyer contact verified",
  confirmed: "Invoice confirmed",
  queried: "Query raised",
  rejected: "Invoice rejected",
  payment_reported: "Payment reported",
  payment_link_created: "Secure payment link created",
  payment_confirmed: "Payment confirmed",
  claimed: "Added to Buyer Rails",
  reminder_sent: "Payment reminder sent",
};

export function readAndClearRoomToken(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = new URLSearchParams(hash).get("token")?.trim() ?? null;
  if (hash) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return token;
}

export function actionKey(): string {
  return crypto.randomUUID();
}

export function localDateTimeValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function formatAmount(value: string, currency: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return `${currency} ${value}`;
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(number);
  } catch {
    return `${currency} ${number.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  }
}

export function formatDate(value: string | null): string {
  if (!value) return "Not specified";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function errorMessage(error: unknown): string {
  return (
    serverErrorFrom(error) ??
    (error instanceof Error ? error.message : null) ??
    "That action could not be completed. Check your connection and try again."
  );
}

export function statusTone(detail: InvoiceRoomDetail): {
  label: string;
  className: string;
  Icon: typeof CheckCircle2;
} {
  if (detail.payment.settled) {
    return {
      label: "Payment confirmed",
      className: "border-emerald-300 bg-emerald-50 text-emerald-800",
      Icon: CheckCircle2,
    };
  }
  if (detail.confirmation?.state === "rejected") {
    return {
      label: "Rejected",
      className: "border-red-300 bg-red-50 text-red-800",
      Icon: XCircle,
    };
  }
  if (detail.confirmation?.state === "queried") {
    return {
      label: "Query raised",
      className: "border-amber-300 bg-amber-50 text-amber-900",
      Icon: AlertCircle,
    };
  }
  if (detail.confirmation?.state === "confirmed") {
    return {
      label: "Invoice confirmed",
      className: "border-teal-300 bg-teal-50 text-teal-800",
      Icon: CheckCircle2,
    };
  }
  return {
    label: detail.room.identityVerified
      ? "Awaiting your response"
      : "Verification required",
    className: "border-slate-300 bg-white text-slate-700",
    Icon: detail.room.identityVerified ? Clock3 : LockKeyhole,
  };
}
