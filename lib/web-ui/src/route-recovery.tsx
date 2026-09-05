import {
  Component,
  Suspense,
  lazy,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Home, RefreshCw, RotateCcw } from "lucide-react";

export function RouteLoading({ label = "Loading page" }: { label?: string }) {
  return (
    <section
      className="w-full min-w-0 text-foreground"
      style={{ minHeight: "20rem" }}
      aria-busy="true"
    >
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
      >
        <RefreshCw
          className="size-4 motion-safe:animate-spin"
          aria-hidden="true"
        />
        {label}
      </p>
      <div aria-hidden="true" className="space-y-4">
        <div className="h-8 w-1/2 rounded bg-muted" />
        <div className="h-40 w-full rounded bg-muted" />
      </div>
    </section>
  );
}

interface BoundaryProps {
  children: ReactNode;
  onRetry?: () => void;
  homeHref?: string;
}
export class RouteErrorBoundary extends Component<
  BoundaryProps,
  { failed: boolean; reference?: string }
> {
  state: { failed: boolean; reference?: string } = { failed: false };
  static getDerivedStateFromError(error: unknown) {
    const value = (error as { requestId?: unknown } | null)?.requestId;
    return {
      failed: true,
      reference:
        typeof value === "string" && /^[\w-]{1,128}$/.test(value)
          ? value
          : undefined,
    };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const button =
      "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    return (
      <section
        className="w-full min-w-0 py-8 text-foreground"
        style={{ minHeight: "20rem" }}
      >
        <div role="alert">
          <h1 className="text-xl font-semibold">This page could not open</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your workspace navigation is still available. Try again, or reload
            the page.
          </p>
          {this.state.reference && (
            <p className="mt-2 break-all text-sm">
              Request reference: {this.state.reference}
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            onClick={() => {
              this.props.onRetry?.();
              this.setState({ failed: false, reference: undefined });
            }}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </button>
          <button
            type="button"
            className={button}
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Reload page
          </button>
          <a className={button} href={this.props.homeHref ?? "/login"}>
            <Home className="size-4" aria-hidden="true" />
            Open workspace
          </a>
        </div>
      </section>
    );
  }
}

// Recreate React.lazy after a rejected import; merely resetting a boundary
// would otherwise retry the same cached rejection forever.
export function lazyRoute<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  return function RecoverableRoute(props: Props) {
    const [Page, setPage] = useState(() => lazy(load));
    return (
      <RouteErrorBoundary
        key={typeof window === "undefined" ? "" : window.location.pathname}
        onRetry={() => setPage(() => lazy(load))}
      >
        <Suspense fallback={<RouteLoading />}>
          <Page {...props} />
        </Suspense>
      </RouteErrorBoundary>
    );
  };
}
