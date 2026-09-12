import { Children, type CSSProperties, type ReactNode } from "react";
export {
  CommandMenu,
  type CommandItem,
  type CommandSearchProvider,
} from "./command-menu";

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
      style={{ "--mi-metric-count": Children.count(children) } as CSSProperties}
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
