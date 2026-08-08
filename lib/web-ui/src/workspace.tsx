import {
  Children,
  useCallback,
  useEffect,
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
  description?: string;
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
  return (
    <div
      className={joinClasses("mi-segmented", className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
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

export function CommandMenu({
  items,
  trigger,
  open: controlledOpen,
  onOpenChange,
  title = "Search MeridianIQ",
  placeholder = "Search pages and actions",
  emptyText = "No matching pages or actions.",
}: {
  items: CommandItem[];
  trigger?: (open: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  placeholder?: string;
  emptyText?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
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
    return items.filter((item) =>
      [item.label, item.description, item.group, ...(item.keywords ?? [])]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
  }, [items, query]);

  const show = useCallback(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, [setOpen]);

  const hide = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => restoreFocusRef.current?.focus(), 0);
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

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const choose = (item: CommandItem) => {
    hide();
    item.onSelect();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      return;
    }
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
        >
          <section
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
            >
              {filtered.length === 0 ? (
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
