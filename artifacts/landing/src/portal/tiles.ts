import {
  FileCheck2,
  Building2,
  Store,
  Calculator,
  Landmark,
} from "lucide-react";

export type Role =
  | "firm_admin"
  | "firm_staff"
  | "client_user"
  | "operator"
  | "bank_user"
  | "buyer_user"
  | "auditor";

export interface AppTile {
  key: string;
  name: string;
  tagline: string;
  href: string;
  icon: typeof FileCheck2;
  // null = public (no login). Otherwise the roles that can open it.
  allowedRoles: Role[] | null;
  accent: string; // tailwind text color for the icon
}

export const APPS: AppTile[] = [
  {
    key: "bank-data-room",
    name: "Bank Data Room",
    tagline:
      "Review consented, anonymized credit-readiness cohorts under your institution's governed access profile.",
    href: "/console/data-room",
    icon: Landmark,
    allowedRoles: ["bank_user"],
    accent: "text-emerald-700 dark:text-emerald-400",
  },
  {
    key: "sme",
    name: "Compliance Workspace",
    tagline:
      "Create and submit invoices, keep the stamped copies, and stay ahead of deadlines.",
    href: "/app/",
    icon: FileCheck2,
    allowedRoles: ["firm_admin", "firm_staff", "client_user"],
    accent: "text-teal-600 dark:text-teal-400",
  },
  {
    key: "console",
    name: "Accountant Console",
    tagline:
      "Manage all your clients' compliance in one place — onboarding, daily work and billing.",
    href: "/console/",
    icon: Building2,
    allowedRoles: ["firm_admin", "firm_staff", "operator", "auditor"],
    accent: "text-indigo-600 dark:text-indigo-400",
  },
  {
    key: "buyer",
    name: "Buyer Rails",
    tagline:
      "Check and confirm supplier invoices before paying, and protect your VAT claims.",
    href: "/buyer/",
    icon: Store,
    allowedRoles: ["buyer_user"],
    accent: "text-blue-600 dark:text-blue-400",
  },
  {
    key: "calc",
    name: "Penalty Calculator",
    tagline:
      "See what late or missing e-invoicing could cost in fines, based on your turnover. Free — no account needed.",
    href: "/penalty-calculator/",
    icon: Calculator,
    allowedRoles: null,
    accent: "text-amber-600 dark:text-amber-400",
  },
];

export function roleLabel(role: string): string {
  return (
    {
      firm_admin: "Firm admin",
      firm_staff: "Firm staff",
      client_user: "Business user",
      operator: "Operator",
      bank_user: "Bank reviewer",
      buyer_user: "Buyer",
      auditor: "Auditor",
    }[role] ?? role
  );
}

// "Firm admin and Firm staff" / "Firm admin, Firm staff and Operator"
export function roleListLabel(roles: Role[]): string {
  const names = roles.map(roleLabel);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
