import { useEffect } from "react";
import { CircleHelp, Mail } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePageTitle } from "@/hooks/use-page-title";

// In-app help for the console (Nielsen #10): task-focused, concrete steps,
// deliberately small. Launch-active firm workflows only — staged desks get
// their topics when their flags light. The command menu lists every topic
// (group "Help"); content is the short form of docs/USER_MANUAL.md — keep
// the two in agreement.

export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  steps: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "getting-started",
    title: "Set up your first client",
    summary:
      "Add the client, invite their owner, and their workspace is live once they accept.",
    steps: [
      "From the Portfolio, select \"Add client\" and enter the business's details.",
      "Go to Team invitations and create a client login for the owner — you share the one-time link yourself.",
      "Once they accept and grant consent, their invoices and compliance work appear in your portfolio.",
      "The getting-started checklist on the Portfolio tracks exactly where you are.",
    ],
  },
  {
    id: "invite-links",
    title: "How invite links work",
    summary:
      "MeridianIQ never emails invites — you create a one-time link and share it yourself.",
    steps: [
      "\"Create invite link\" makes a link that works exactly once and expires after a while.",
      "Copy it before dismissing the card — it cannot be shown again.",
      "Send it over a channel you trust (the invitee sets their own password on it).",
      "Lost or expired? Select \"New link\" on the pending row — the old one stops working.",
    ],
  },
  {
    id: "client-workspace",
    title: "Inside a client's workspace",
    summary:
      "Each client page shows their invoices, money and setup — tabs appear as features are enabled.",
    steps: [
      "Open any client from the Portfolio (the name is the link).",
      "\"Today\" lists what needs attention; the flag on an invoice explains why via its \"Why?\" note.",
      "\"Export data\" downloads the client's full record bundle whenever you need it.",
    ],
  },
  {
    id: "penalty-risk",
    title: "How penalty risk is ranked",
    summary:
      "Risk reflects statutory exposure: overdue submissions rank highest, then approaching deadlines.",
    steps: [
      "High: submissions past their statutory window — penalties are accruing.",
      "Medium: deadlines inside the next few days, or repeated failures.",
      "Low: on track. The \"What does this mean?\" note next to any risk badge explains the ranking in place.",
    ],
  },
  {
    id: "onboarding-runs",
    title: "Onboarding runs",
    summary:
      "A per-client checklist that proves the setup is complete — re-checkable at any time.",
    steps: [
      "Start a run from the client's Setup tab; each step verifies itself against the client's real records.",
      "\"Re-check\" any step after fixing something — the run updates in place.",
      "\"Close without completing\" ends a run (with a confirmation); you can start a fresh one later.",
    ],
  },
  {
    id: "audit-evidence",
    title: "Audit records and exports",
    summary:
      "Everything material is recorded permanently and can be exported and verified outside MeridianIQ.",
    steps: [
      "Audit & evidence lists the recorded events; nothing there can be edited or deleted.",
      "Export bundles are hash-chained — an auditor can verify them without a MeridianIQ account.",
      "A client's own data exports live on their client page (\"Export data\").",
    ],
  },
];

export function Help() {
  usePageTitle("Help");

  useEffect(() => {
    const scrollToTopic = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    };
    scrollToTopic();
    window.addEventListener("hashchange", scrollToTopic);
    return () => window.removeEventListener("hashchange", scrollToTopic);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Help
        </h1>
        <p className="text-muted-foreground mt-1">
          Short answers for the firm workflows this console does today.
        </p>
      </div>

      <nav aria-label="Help topics" className="flex flex-wrap gap-2">
        {HELP_TOPICS.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold text-foreground hover:border-primary hover:text-primary"
            data-testid={`help-topic-${t.id}`}
          >
            {t.title}
          </a>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        {HELP_TOPICS.map((t) => (
          <Card key={t.id} id={t.id} className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="flex items-start gap-2 text-base">
                <CircleHelp
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                {t.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold">{t.summary}</p>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                {t.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="flex items-center gap-2 border-t pt-5 text-sm text-muted-foreground">
        <Mail className="size-4 shrink-0" aria-hidden="true" />
        Something these don't cover? Write to&nbsp;
        <a
          className="font-bold text-primary underline underline-offset-2"
          href="mailto:advisory@meridianiq.com"
          data-testid="link-help-contact"
        >
          advisory@meridianiq.com
        </a>
        .
      </p>
    </div>
  );
}
