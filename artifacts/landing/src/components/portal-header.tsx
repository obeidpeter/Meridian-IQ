import { ValoMark } from "@workspace/web-ui";

// The shared portal chrome: header shell + Valo brand mark, with the
// page-specific element (session badge, sign-in shortcut, …) in the right slot.
// The public landing page keeps its own editorial header spacing.
export function PortalHeader({ right }: { right?: React.ReactNode }) {
  return (
    <header className="border-b bg-card/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Valo home"
        >
          <div className="text-[#536149]">
            <ValoMark className="h-8 w-8" aria-hidden="true" />
          </div>
          <div>
            <p className="text-base font-semibold leading-none">Valo</p>
            <p className="text-xs text-muted-foreground">
              Compliance & verified receivables
            </p>
          </div>
        </a>
        {right}
      </div>
    </header>
  );
}
