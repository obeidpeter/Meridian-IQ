import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function WorkspaceHeader({
  eyebrow,
  title,
  description,
  status,
  actions,
  className,
  titleTestId = "text-page-title",
}: {
  eyebrow?: string;
  title: string;
  /** One line under the title; a node so pages can append a help link. */
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleTestId?: string;
}) {
  return (
    <header className={joinClasses("mi-workspace-header", className)}>
      <div className="mi-workspace-header__copy">
        {eyebrow ? <p className="mi-eyebrow">{eyebrow}</p> : null}
        <div className="mi-workspace-header__title-row">
          <h1 data-testid={titleTestId}>{title}</h1>
          {status}
        </div>
        {description ? (
          <p className="mi-workspace-header__description">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="mi-workspace-header__actions">{actions}</div>
      ) : null}
    </header>
  );
}

export type MetricTone =
  | "default"
  | "positive"
  | "warning"
  | "critical"
  | "info";

export function MetricStrip({
  children,
  label = "Key metrics",
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <section
      className={joinClasses("mi-metric-strip", className)}
      aria-label={label}
      style={
        { "--mi-metric-count": Children.count(children) } as CSSProperties
      }
    >
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  detail,
  icon,
  tone = "default",
  action,
  testId,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: MetricTone;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mi-metric" data-tone={tone} data-testid={testId}>
      <div className="mi-metric__topline">
        <p className="mi-metric__label">{label}</p>
        {icon ? <span className="mi-metric__icon">{icon}</span> : null}
      </div>
      <p className="mi-metric__value">{value}</p>
      <div className="mi-metric__footer">
        {detail ? <p className="mi-metric__detail">{detail}</p> : <span />}
        {action}
      </div>
    </div>
  );
}

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
  testIdPrefix,
}: {
  items: Array<SegmentedItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  testIdPrefix?: string;
}) {
  // A segmented switcher is a group of toggle buttons, not tabs: consumers
  // filter lists in place and no tabpanel exists, so aria-pressed states the
  // truth without the tabs keyboard contract (real tab UIs use Radix Tabs).
  return (
    <div
      className={joinClasses("mi-segmented", className)}
      role="group"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          className="mi-segmented__item"
          onClick={() => onChange(item.value)}
          data-testid={
            testIdPrefix ? `${testIdPrefix}-${item.value}` : undefined
          }
        >
          <span>{item.label}</span>
          {item.count !== undefined ? (
            <span className="mi-segmented__count">{item.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export type WorkItemTone =
  | "neutral"
  | "info"
  | "warning"
  | "critical"
  | "positive";

export interface WorkQueueItem {
  id: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  icon?: ReactNode;
  tone?: WorkItemTone;
  action?: ReactNode;
}

export function WorkQueue({
  title,
  description,
  items,
  emptyTitle = "Nothing needs attention",
  emptyDescription = "Your priority queue is clear.",
  toolbar,
  className,
}: {
  title: string;
  description?: string;
  items: WorkQueueItem[];
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: ReactNode;
  className?: string;
}) {
  return (
    <section className={joinClasses("mi-work-queue", className)}>
      <div className="mi-work-queue__header">
        <div>
          <p className="mi-work-queue__title">{title}</p>
          {description ? (
            <p className="mi-work-queue__description">{description}</p>
          ) : null}
        </div>
        {toolbar}
      </div>
      {items.length === 0 ? (
        <div className="mi-work-queue__empty">
          <p>{emptyTitle}</p>
          <span>{emptyDescription}</span>
        </div>
      ) : (
        <ol className="mi-work-queue__list">
          {items.map((item) => (
            <li
              key={item.id}
              className="mi-work-item"
              data-tone={item.tone ?? "neutral"}
            >
              <span className="mi-work-item__marker" aria-hidden="true" />
              {item.icon ? (
                <span className="mi-work-item__icon">{item.icon}</span>
              ) : null}
              <div className="mi-work-item__copy">
                <p className="mi-work-item__title">{item.title}</p>
                {item.description ? (
                  <p className="mi-work-item__description">
                    {item.description}
                  </p>
                ) : null}
                {item.meta ? (
                  <div className="mi-work-item__meta">{item.meta}</div>
                ) : null}
              </div>
              {item.action ? (
                <div className="mi-work-item__action">{item.action}</div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

export type CommandSearchProvider = (
  query: string,
  signal: AbortSignal,
) => Promise<CommandItem[]>;

export function CommandMenu({
  items,
  trigger,
  open: controlledOpen,
  onOpenChange,
  title = "Search Valo",
  placeholder = "Search pages and actions",
  emptyText = "No matching pages or actions.",
  remoteSearch,
  minimumSearchLength = 2,
}: {
  items: CommandItem[];
  trigger?: (open: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  placeholder?: string;
  emptyText?: string;
  remoteSearch?: CommandSearchProvider;
  minimumSearchLength?: number;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [remoteItems, setRemoteItems] = useState<CommandItem[]>([]);
  const [remoteState, setRemoteState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const initiatingElementRef = useRef<Element | null>(null);
  const restoreOnCloseRef = useRef(true);
  const open = controlledOpen ?? internalOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    const local = items.filter((item) =>
      [item.label, item.description, item.group, ...(item.keywords ?? [])]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
    const seen = new Set(local.map((item) => item.id));
    return [...local, ...remoteItems.filter((item) => !seen.has(item.id))];
  }, [items, query, remoteItems]);

  const show = useCallback(() => {
    setOpen(true);
  }, [setOpen]);

  const hide = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, [setOpen]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) hide();
        else show();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, hide, show]);

  useLayoutEffect(() => {
    if (!open) return;
    // Capture external triggers and focus before paint, so immediate keys reach the dialog.
    initiatingElementRef.current = document.activeElement;
    restoreOnCloseRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const initiatingElement = initiatingElementRef.current;
    const section = sectionRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      const activeElement = document.activeElement;
      if (
        restoreOnCloseRef.current &&
        initiatingElement instanceof HTMLElement &&
        initiatingElement.isConnected &&
        !section?.contains(initiatingElement) &&
        (activeElement === document.body || section?.contains(activeElement))
      ) {
        initiatingElement.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const needle = query.trim();
    if (!open || !remoteSearch || needle.length < minimumSearchLength) {
      setRemoteItems([]);
      setRemoteState("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRemoteState("loading");
      void remoteSearch(needle, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return;
          setRemoteItems(results);
          setRemoteState("ready");
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setRemoteItems([]);
          setRemoteState("error");
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [minimumSearchLength, open, query, remoteSearch]);

  useEffect(() => {
    setActiveIndex((index) => Math.max(0, Math.min(index, filtered.length - 1)));
  }, [filtered.length]);

  const choose = (item: CommandItem) => {
    // Navigation or another action owns focus after a command is selected.
    restoreOnCloseRef.current = false;
    hide();
    item.onSelect();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]);
    }
  };

  // The menu declares aria-modal, so it must behave modally: Escape closes it
  // from anywhere inside (not just the search input), and Tab cycles within
  // the dialog instead of walking into the inert page behind the backdrop.
  const handleBackdropKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      return;
    }
    if (event.key !== "Tab") return;
    const section = sectionRef.current;
    if (!section) return;
    const focusables = Array.from(
      section.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !section.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !section.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {trigger ? trigger(show) : null}
      {open ? (
        <div
          className="mi-command-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) hide();
          }}
          onKeyDown={handleBackdropKeyDown}
        >
          <section
            ref={sectionRef}
            className="mi-command"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mi-command-title"
          >
            <div className="mi-command__search">
              <div className="mi-command__search-copy">
                <p id="mi-command-title">{title}</p>
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder={placeholder}
                  aria-controls="mi-command-results"
                  aria-activedescendant={filtered[activeIndex]?.id}
                />
              </div>
              <button
                type="button"
                className="mi-command__close"
                onClick={hide}
              >
                <span aria-hidden="true">Esc</span>
                <span className="mi-sr-only">Close command menu</span>
              </button>
            </div>
            <div
              className="mi-command__results"
              id="mi-command-results"
              role="listbox"
              aria-busy={remoteState === "loading"}
            >
              {remoteState === "loading" && filtered.length === 0 ? (
                <p className="mi-command__empty" role="status">
                  Searching workspace records…
                </p>
              ) : filtered.length === 0 ? (
                <p className="mi-command__empty">{emptyText}</p>
              ) : (
                filtered.map((item, index) => (
                  <button
                    type="button"
                    key={item.id}
                    id={item.id}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="mi-command__item"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(item)}
                  >
                    {item.icon ? (
                      <span className="mi-command__icon">{item.icon}</span>
                    ) : null}
                    <span className="mi-command__item-copy">
                      <strong>{item.label}</strong>
                      {item.description ? (
                        <small>{item.description}</small>
                      ) : null}
                    </span>
                    {item.group ? (
                      <span className="mi-command__group">{item.group}</span>
                    ) : null}
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                ))
              )}
            </div>
            <p className="mi-sr-only" role="status" aria-live="polite">
              {remoteState === "ready"
                ? `${remoteItems.length} workspace record${remoteItems.length === 1 ? "" : "s"} found.`
                : remoteState === "error"
                  ? "Workspace search is temporarily unavailable. Page and action results are still shown."
                  : ""}
            </p>
            <footer className="mi-command__footer">
              <span>
                <kbd>Enter</kbd> open
              </span>
              <span>
                <kbd>Up/Down</kbd> navigate
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
