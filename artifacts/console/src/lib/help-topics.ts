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
      "Add the client and invite a business user to access their workspace.",
    steps: [
      'From the Portfolio, select "Add client" and enter the business\'s details.',
      "Go to Invitations and invite a business user for that client. Share the one-time link yourself.",
      "Once they accept and grant consent, their invoices and compliance work appear in your portfolio.",
      "The getting-started checklist on the Portfolio tracks exactly where you are.",
    ],
  },
  {
    id: "invite-links",
    title: "How invite links work",
    summary:
      "Valo never emails invites — you create a one-time link and share it yourself.",
    steps: [
      '"Create invite link" makes a link that works exactly once and expires after a while.',
      "Copy it before dismissing the card — it cannot be shown again.",
      "Send it over a channel you trust (the invitee sets their own password on it).",
      'Lost or expired? Select "New link" on the pending row — the old one stops working.',
    ],
  },
  {
    id: "client-workspace",
    title: "Inside a client's workspace",
    summary:
      "Each client page shows their invoices, money and setup — tabs appear as features are enabled.",
    steps: [
      "Open any client from the Portfolio (the name is the link).",
      '"Today" lists what needs attention; the flag on an invoice explains why via its "Why?" note.',
      '"Export data" downloads the client\'s full record bundle whenever you need it.',
    ],
  },
  {
    id: "assign-clients",
    title: "Assign clients to your team",
    summary:
      "The Team card on a client page says who looks after it — it shapes each person's My clients view, never who may open the client.",
    steps: [
      'Open the client and find the "Team" card. Firm admins select the members who look after this client, then select "Save changes".',
      'On the Portfolio, "My clients" shows your assigned clients plus every unassigned client. "All clients" shows every client your firm manages.',
      "Staff with at least one assignment land on My clients; admins and unassigned staff land on All clients.",
      "Every add and removal is recorded on the audit trail. Unassigned clients stay visible to everyone.",
    ],
  },
  {
    id: "access-review",
    title: "Run an access review",
    summary:
      "Check who can open your firm's workspaces, then record that you reviewed their access.",
    steps: [
      "Open Access review from Client services and setup (firm admins only).",
      "Check each member's role, access start date, last sign-in, two-factor authentication (2FA) and assigned clients. Accounts without 2FA or a previous sign-in are flagged.",
      '"Download CSV" gives you the same register as a spreadsheet.',
      'Select "Attest as reviewed" to record your confirmation against this version of the access register. You can confirm again after the register changes.',
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
      'Low: on track. The "What does this mean?" note next to any risk badge explains the ranking in place.',
    ],
  },
  {
    id: "onboarding-runs",
    title: "Onboarding checklists",
    summary:
      "A checklist for each client showing completed steps, pending work and recorded gaps.",
    steps: [
      "Start a checklist from the client's Setup tab. Steps are checked against saved records; skipped steps remain recorded gaps.",
      'Select "Check again" after fixing a step to update the active checklist.',
      '"Close without completing" ends the checklist after confirmation. A closed checklist no longer updates; you can start a new one later.',
    ],
  },
  {
    id: "audit-evidence",
    title: "Audit records and exports",
    summary:
      "Everything material is recorded permanently and can be exported and verified outside Valo.",
    steps: [
      "Audit and evidence lists the recorded events; nothing there can be edited or deleted.",
      "Export bundles are hash-chained — an auditor can verify them without a Valo account.",
      'A client\'s own data exports live on their client page ("Export data").',
    ],
  },
];
