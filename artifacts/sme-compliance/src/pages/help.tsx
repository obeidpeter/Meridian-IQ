import { useEffect } from "react";
import { CircleHelp, Mail } from "lucide-react";
import { ADVISORY_EMAIL } from "@workspace/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  HelpFeedback,
  HelpSearchInput,
  useHelpSearch,
} from "@workspace/web-ui";

// In-app help (Nielsen #10): task-focused, concrete steps, deliberately
// small. Topics cover the launch-active surfaces only — a staged feature
// gets its topic when its flag lights. The command menu lists every topic
// (group "Help") and the four heaviest concepts deep-link here from their
// own pages, so answers are one step away from the work. Content is the
// short form of docs/USER_MANUAL.md — keep the two in agreement.

export interface HelpTopic {
  id: string;
  title: string;
  /** One-line answer first, then the steps. */
  summary: string;
  steps: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "create-invoice",
    title: "Create and send an invoice",
    summary:
      "An invoice starts as a draft, gets checked, then goes for stamping.",
    steps: [
      'Go to Invoices and select "New invoice".',
      "Pick the customer, add your line items and check the totals in the sidebar.",
      'Select "Create invoice" — it is saved as a draft in your vault.',
      'On the invoice page, select "Submit for stamping" when you are ready. We check it first and show anything that needs fixing.',
    ],
  },
  {
    id: "stamping",
    title: 'What "stamping" means',
    summary:
      "Stamping is FIRS officially registering your invoice. The stamp is your proof.",
    steps: [
      "When you submit an invoice, we send it to FIRS (the tax authority).",
      "FIRS returns an official stamp: the Invoice Reference Number (IRN) and a stamp certificate (CSID).",
      "We save the stamp with the invoice — you never need to keep copies yourself.",
      "A stamped invoice cannot be edited. If something is wrong, cancel it with a credit note and issue a new one.",
    ],
  },
  {
    id: "failed-submission",
    title: "Fix a failed submission",
    summary:
      "A rejected invoice shows the reason and a form to fix it — nothing is lost.",
    steps: [
      "Open the invoice. The red card explains what FIRS rejected and why.",
      'Select "Fix & resubmit", correct the highlighted details and send it again.',
      "If the same rejection keeps coming back, ask your accountant — the reason text tells them exactly what to check.",
    ],
  },
  {
    id: "duplicate-invoice",
    title: "Repeat a previous invoice",
    summary:
      '"New from this invoice" copies an invoice into a fresh draft so you never retype regular work.',
    steps: [
      'Open the invoice you want to repeat and select "New from this invoice".',
      "A new draft opens with the same customer, lines and currency — today's date, and a blank invoice number for you to set.",
      "Adjust anything that changed, then create and submit as usual.",
    ],
  },
  {
    id: "bulk-import",
    title: "Upload many invoices at once",
    summary:
      "The importer checks every row before anything is created — up to 5,000 rows.",
    steps: [
      "Go to Import and download the CSV or Excel template.",
      'Fill it in (or paste rows directly), then select "Validate rows".',
      "Fix anything marked invalid — you can download the failed rows, correct them and try again.",
      'Select "Import valid rows". Imported invoices are drafts: submit them from the vault when ready.',
    ],
  },
  {
    id: "drafts",
    title: "Where your unfinished work goes",
    summary:
      "Unfinished invoices save automatically to your account when connected, with a separate recovery copy on this device.",
    steps: [
      'Check the save status above the form. "Saved to your account" means you can resume from New invoice on another device, signed into the same account and business.',
      "Unfinished account drafts expire seven days after their last successful save. Check the saved time and expiry before leaving important work unfinished.",
      '"Saved on this device only" means account sync is pending. Return on this browser and reconnect. If it says "Not saved", keep the tab open and retry.',
      '"Discard" removes the unfinished account draft and this tab\'s recovery copy. Use the immediate Undo action to restore it as a new draft.',
      '"Create invoice" creates a separate invoice record in Invoices. The seven-day unfinished-draft limit does not apply to that record; it still needs submission for stamping.',
    ],
  },
  {
    id: "recover-invoice",
    title: "Recover an interrupted invoice or conflicting edit",
    summary:
      "Check the existing result before starting again, so you do not create a duplicate.",
    steps: [
      'If creation is not confirmed, select "Retry original invoice" on the same device. Valo checks the original request without creating a second invoice.',
      'Use Operation history to check whether recent work completed. "View invoice" returns you to the invoice or unfinished form.',
      "If the original request is unavailable on this device, check Invoices and Operation history, or ask your accountant, before creating a replacement.",
      'For conflicting edits, compare your version with the saved version. Reload the account version, or save your unfinished edits as a new draft. For an existing invoice, "Keep my edits" keeps them in the form for review; it does not save them yet.',
    ],
  },
  {
    id: "vat",
    title: "Your VAT position",
    summary:
      "VAT you charged on sales minus VAT you paid on purchases, month by month.",
    steps: [
      "The VAT page adds up output VAT from your issued invoices and input VAT from supplier bills.",
      '"Verified" figures come from stamped documents; unverified ones still need their stamp.',
      "The page shows when the next return is due — your accountant files it, this is your live view.",
    ],
  },
  {
    id: "month-end",
    title: "The month-end close",
    summary:
      "A checklist that makes sure a month's records are complete before you move on.",
    steps: [
      "Month-end lists anything unfinished: unsubmitted invoices, missing records, unmatched payments.",
      "Each item has a Review button that takes you to the page where you fix it.",
      "When every check clears, the month is ready — nothing is locked, it is a readiness check, not a padlock.",
    ],
  },
  {
    id: "consent",
    title: "Consent: who can use your data",
    summary:
      "Three switches you control. Your accountant's firm can only use your data where you have said yes.",
    steps: [
      "Layer 1 covers the core compliance work — submitting invoices and keeping your vault.",
      "Layers 2 and 3 cover optional extras, explained on the Consent page.",
      "You can revoke any layer at any time; dependent features stop within a minute. Every grant and revoke is recorded permanently.",
    ],
  },
  {
    id: "first-sign-in-consent",
    title: "Your first sign-in: the consent step",
    summary:
      "The first time the business's own account signs in, you choose what Valo may do before the workspace opens.",
    steps: [
      'Answer "Allow" or "Not now" for layers 1 and 2. Credit readiness is a separate, optional Layer 3 choice you can review from Consent after setup.',
      'Both answers are recorded — including "Not now" — so the step never comes back.',
      "Declining layer 1 is allowed, but nothing can be submitted or stamped for you until you allow it from the Consent page.",
      "Accountant and firm accounts never see this step: consent belongs to the business's own account.",
    ],
  },
  {
    id: "deadlines",
    title: "Deadlines and reminders",
    summary:
      "The calendar computes your statutory deadlines from your own invoice book — Lagos time.",
    steps: [
      "The Calendar page lists what is due, with plain labels: Due today, Overdue, In N days.",
      'The dashboard\'s "Next deadline" card always shows the closest one.',
      "Alert settings control how you are reminded as delivery channels roll out.",
    ],
  },
];

export function Help() {
  usePageTitle("Help");
  const help = useHelpSearch(HELP_TOPICS, "sme_help");

  // Deep links (/help#topic) land with the topic on screen; the command menu
  // and the contextual "learn more" links rely on this. hashchange covers
  // picking a second topic while already here.
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
      <PageHeader
        title="Help"
        description="Short answers for the work this app does today. Your accountant is the right contact for tax questions about your business."
      />

      <HelpSearchInput
        query={help.query}
        onQueryChange={help.setQuery}
        resultCount={help.filteredTopics.length}
      />

      <nav aria-label="Help topics" className="flex flex-wrap gap-2">
        {help.filteredTopics.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-teal-700 hover:text-teal-800"
            data-testid={`help-topic-${t.id}`}
          >
            {t.title}
          </a>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        {help.filteredTopics.map((t) => (
          <Card key={t.id} id={t.id} className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="flex items-start gap-2 text-base">
                <CircleHelp
                  className="mt-0.5 size-4 shrink-0 text-teal-700"
                  aria-hidden="true"
                />
                {t.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold text-slate-800">
                {t.summary}
              </p>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                {t.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>

      {help.filteredTopics.length === 0 && (
        <section
          role="status"
          className="rounded-md border border-dashed border-slate-300 p-8 text-center"
          data-testid="help-no-results"
        >
          <h2 className="text-base font-semibold text-slate-900">
            No matching help topic
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a broader term, or ask your accountant using the contact below.
          </p>
        </section>
      )}

      <HelpFeedback surface="sme_help" />

      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Mail className="size-4 shrink-0" aria-hidden="true" />
        Stuck on something these don't cover? Ask your accountant — or write
        to&nbsp;
        <a
          className="font-bold text-teal-800 underline underline-offset-2"
          href={`mailto:${ADVISORY_EMAIL}`}
          data-testid="link-help-contact"
        >
          Valo support
        </a>
        .
      </p>
    </div>
  );
}
