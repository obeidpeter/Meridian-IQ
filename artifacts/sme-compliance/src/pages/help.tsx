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

import { HELP_TOPICS } from "@/lib/help-topics";
export { HELP_TOPICS, type HelpTopic } from "@/lib/help-topics";

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
