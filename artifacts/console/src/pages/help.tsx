import { useEffect } from "react";
import { CircleHelp, Mail } from "lucide-react";
import { ADVISORY_EMAIL } from "@workspace/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const help = useHelpSearch(HELP_TOPICS, "console_help");

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
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold text-foreground hover:border-primary hover:text-primary"
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

      {help.filteredTopics.length === 0 && (
        <section
          role="status"
          className="rounded-md border border-dashed p-8 text-center"
          data-testid="help-no-results"
        >
          <h2 className="text-base font-semibold">No matching help topic</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a broader term, or contact the advisory team below.
          </p>
        </section>
      )}

      <HelpFeedback surface="console_help" />

      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Mail className="size-4 shrink-0" aria-hidden="true" />
        Something these don't cover? Write to&nbsp;
        <a
          className="font-bold text-primary underline underline-offset-2"
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
