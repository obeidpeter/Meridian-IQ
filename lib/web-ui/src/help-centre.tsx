import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { trackUsabilityEvent, type UsabilitySurface } from "./usability";

export interface SearchableHelpTopic {
  id: string;
  title: string;
  summary: string;
  steps: string[];
}

export type HelpSurface = Extract<
  UsabilitySurface,
  "console_help" | "sme_help"
>;

export function filterHelpTopics<T extends SearchableHelpTopic>(
  topics: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...topics];
  return topics.filter((topic) =>
    [topic.title, topic.summary, ...topic.steps]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function useHelpSearch<T extends SearchableHelpTopic>(
  topics: readonly T[],
  surface: HelpSurface,
) {
  const [query, setQuery] = useState("");
  const filteredTopics = useMemo(
    () => filterHelpTopics(topics, query),
    [topics, query],
  );
  const zeroReported = useRef(false);

  useEffect(() => {
    trackUsabilityEvent("help_opened", surface);
  }, [surface]);

  useEffect(() => {
    const noMatch = query.trim().length >= 2 && filteredTopics.length === 0;
    if (!noMatch) {
      zeroReported.current = false;
      return;
    }
    if (zeroReported.current) return;
    zeroReported.current = true;
    trackUsabilityEvent("help_search_no_result", surface);
  }, [filteredTopics.length, query, surface]);

  return { query, setQuery, filteredTopics };
}

export function HelpSearchInput({
  query,
  onQueryChange,
  resultCount,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  resultCount: number;
}) {
  return (
    <div className="mi-help-search" role="search">
      <Search aria-hidden="true" />
      <label htmlFor="mi-help-search-input" className="mi-sr-only">
        Search help topics
      </label>
      <input
        id="mi-help-search-input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search help topics"
        autoComplete="off"
      />
      {query ? (
        <button
          type="button"
          onClick={() => onQueryChange("")}
          aria-label="Clear help search"
          title="Clear search"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      <span className="mi-help-search__count" aria-live="polite">
        {resultCount} topic{resultCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function HelpFeedback({ surface }: { surface: HelpSurface }) {
  const [choice, setChoice] = useState<"helpful" | "unhelpful" | null>(null);
  const choose = (next: "helpful" | "unhelpful") => {
    if (choice) return;
    setChoice(next);
    trackUsabilityEvent(
      next === "helpful" ? "help_helpful" : "help_unhelpful",
      surface,
    );
  };
  return (
    <section className="mi-help-feedback" aria-label="Help feedback">
      <div>
        <strong>{choice ? "Thanks for the feedback" : "Did this help?"}</strong>
        <p>
          {choice
            ? "Your response is recorded as an anonymous aggregate only."
            : "Your response helps improve these guides. No page or account details are sent."}
        </p>
      </div>
      <div className="mi-help-feedback__actions">
        <button
          type="button"
          aria-label="Yes, this help was useful"
          aria-pressed={choice === "helpful"}
          disabled={choice !== null}
          onClick={() => choose("helpful")}
        >
          <ThumbsUp aria-hidden="true" />
          Yes
        </button>
        <button
          type="button"
          aria-label="No, this help was not useful"
          aria-pressed={choice === "unhelpful"}
          disabled={choice !== null}
          onClick={() => choose("unhelpful")}
        >
          <ThumbsDown aria-hidden="true" />
          No
        </button>
      </div>
    </section>
  );
}
