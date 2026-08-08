import { Link } from "wouter";
import type { ComponentType } from "react";
import {
  Bot,
  BriefcaseBusiness,
  DatabaseZap,
  Fingerprint,
  Gauge,
  Network,
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

export type ControlCentreSection =
  | "activation"
  | "buyers"
  | "cases"
  | "reliability"
  | "evidence"
  | "clerk";

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
      "Release gates, commercial activation and live proof from the operational spine.",
    icon: Gauge,
  },
  {
    key: "buyers",
    label: "Buyer pilots",
    title: "Buyer Rails pilots",
    description:
      "Anchor-buyer participation, response behavior and scale-readiness evidence.",
    icon: Network,
  },
  {
    key: "cases",
    label: "Cases",
    title: "Compliance case orchestration",
    description:
      "One SLA-ranked view of managed cases, statutory deadlines and buyer exceptions.",
    icon: BriefcaseBusiness,
  },
  {
    key: "reliability",
    label: "Reliability",
    title: "Integration reliability",
    description:
      "Connector freshness, run outcomes, row quality and platform-delivery health.",
    icon: DatabaseZap,
  },
  {
    key: "evidence",
    label: "Evidence vault",
    title: "Evidence vault and trust",
    description:
      "Durable compliance artifacts, chain verification and enterprise control posture.",
    icon: Fingerprint,
  },
  {
    key: "clerk",
    label: "Clerk assurance",
    title: "Clerk operational assurance",
    description:
      "Human-review boundaries, eval quality, grounding and deployment guardrails.",
    icon: Bot,
  },
];

const CONTENT: Record<ControlCentreSection, ComponentType> = {
  activation: ActivationWorkspace,
  buyers: BuyerPilotsWorkspace,
  cases: ComplianceOperationsWorkspace,
  reliability: IntegrationReliabilityWorkspace,
  evidence: EvidenceVaultWorkspace,
  clerk: ClerkAssuranceWorkspace,
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
        <div className="grid min-w-[54rem] grid-cols-6 gap-1">
          {SECTIONS.map((item, index) => {
            const Icon = item.icon;
            const selected = item.key === active.key;
            return (
              <Link
                key={item.key}
                href={`/control-centre/${item.key}`}
                aria-current={selected ? "page" : undefined}
                className={`flex min-h-14 items-center gap-2 rounded-md px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "bg-[#082f31] text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                }`}
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-md ${selected ? "bg-lime-300 text-[#082f31]" : "bg-slate-100 text-slate-500"}`}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-bold text-current opacity-55">
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
