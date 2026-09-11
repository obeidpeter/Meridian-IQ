import { Link } from "wouter";
import type { ComponentType } from "react";
import {
  Bot,
  BriefcaseBusiness,
  DatabaseZap,
  Fingerprint,
  Gauge,
  Network,
  Landmark,
  type LucideIcon,
} from "lucide-react";
import { WorkspaceHeader } from "@workspace/web-ui";
import { usePageTitle } from "@/hooks/use-page-title";
import { StatusPill } from "./shared";
import { ActivationWorkspace } from "./activation";
import { BuyerPilotsWorkspace } from "./buyers";
import { ComplianceOperationsWorkspace } from "./cases";
import { IntegrationReliabilityWorkspace } from "./reliability";
import { EvidenceVaultWorkspace } from "./evidence";
import { ClerkAssuranceWorkspace } from "./clerk";
import { CreditGovernanceWorkspace } from "./credit";

export type ControlCentreSection =
  | "activation"
  | "buyers"
  | "cases"
  | "reliability"
  | "evidence"
  | "clerk"
  | "credit";

const SECTIONS: Array<{
  key: ControlCentreSection;
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: "activation",
    label: "Activation",
    title: "Evidence and activation",
    description:
      "Review release requirements, paid subscriptions and evidence recorded by the platform.",
    icon: Gauge,
  },
  {
    key: "buyers",
    label: "Buyer pilots",
    title: "Buyer pilots",
    description:
      "Review participating buyers, their responses and evidence needed to expand each pilot.",
    icon: Network,
  },
  {
    key: "cases",
    label: "Cases",
    title: "Compliance cases",
    description:
      "Review cases, statutory deadlines and buyer issues by priority and response deadline.",
    icon: BriefcaseBusiness,
  },
  {
    key: "reliability",
    label: "Reliability",
    title: "Integration reliability",
    description:
      "Check when connections last updated, which runs failed and which records need attention.",
    icon: DatabaseZap,
  },
  {
    key: "evidence",
    label: "Evidence vault",
    title: "Saved compliance evidence",
    description:
      "Review saved compliance records, audit-chain verification and data-retention controls.",
    icon: Fingerprint,
  },
  {
    key: "clerk",
    label: "Clerk assurance",
    title: "Clerk quality and safety",
    description:
      "Check human approval controls, test results, source evidence and release safeguards.",
    icon: Bot,
  },
  {
    key: "credit",
    label: "Credit",
    title: "Credit data controls",
    description:
      "Review eligibility rules, know-your-business (KYB) checks, consistency tests and bank access.",
    icon: Landmark,
  },
];

const CONTENT: Record<ControlCentreSection, ComponentType> = {
  activation: ActivationWorkspace,
  buyers: BuyerPilotsWorkspace,
  cases: ComplianceOperationsWorkspace,
  reliability: IntegrationReliabilityWorkspace,
  evidence: EvidenceVaultWorkspace,
  clerk: ClerkAssuranceWorkspace,
  credit: CreditGovernanceWorkspace,
};

export function ControlCentre({ section }: { section: ControlCentreSection }) {
  const active = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0];
  const Content = CONTENT[active.key];
  usePageTitle(`${active.title} | Control centre`);

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Operations control centre"
        title={active.title}
        description={active.description}
        status={<StatusPill status="healthy">Live evidence</StatusPill>}
      />

      <nav
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-1"
        aria-label="Control centre workspaces"
      >
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:min-w-[62rem] lg:grid-cols-7">
          {SECTIONS.map((item, index) => {
            const Icon = item.icon;
            const selected = item.key === active.key;
            return (
              <Link
                key={item.key}
                href={`/control-centre/${item.key}`}
                aria-current={selected ? "page" : undefined}
                className={`flex min-h-14 items-center gap-2 rounded-md px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:focus-visible:ring-teal-700 ${
                  selected
                    ? "bg-[#082f31] text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                }`}
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-md ${selected ? "bg-[#c9a227] text-[#0e2f2a]" : "bg-slate-100 text-slate-500"}`}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-bold text-current">
                    0{index + 1}
                  </span>
                  <span className="block truncate">{item.label}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      <Content />
    </div>
  );
}
