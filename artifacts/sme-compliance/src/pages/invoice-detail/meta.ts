import { type StatusLightLight } from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

// AI Feature Brief §3.3: deterministic green/amber/red light with plain-language
// reasons and ONE recommended action. Icon + word pair with the colour so the
// colour is never the only signal.
export const LIGHT_META: Record<
  StatusLightLight,
  {
    label: string;
    Icon: typeof CheckCircle2;
    dot: string;
    text: string;
  }
> = {
  green: {
    label: "Green",
    Icon: CheckCircle2,
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  amber: {
    label: "Amber",
    Icon: AlertTriangle,
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  red: {
    label: "Red",
    Icon: XCircle,
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
  },
};

export const SETTLEMENT_SOURCE_LABELS: Record<string, string> = {
  statement_match: "Statement match",
  buyer_flag: "Buyer flag",
  collection_account: "Collection account",
  uploaded_evidence: "Uploaded evidence",
};
