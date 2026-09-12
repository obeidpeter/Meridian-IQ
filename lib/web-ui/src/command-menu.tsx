import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

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
    setActiveIndex((index) =>
      Math.max(0, Math.min(index, filtered.length - 1)),
    );
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
                <p className="mi-command__empty">
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
            {/* The one live region for search state, present while the
                menu is open (R115): the searching notice above is plain
                text inside the listbox, this announces it. */}
            <p className="mi-sr-only" role="status" aria-live="polite">
              {remoteState === "ready"
                ? `${remoteItems.length} workspace record${remoteItems.length === 1 ? "" : "s"} found.`
                : remoteState === "error"
                  ? "Workspace search is temporarily unavailable. Page and action results are still shown."
                  : remoteState === "loading"
                    ? "Searching workspace records…"
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
