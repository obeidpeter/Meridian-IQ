/** @jsxRuntime automatic */
// This document also runs inside Vite's Node config; import the standalone mark,
// not the browser UI barrel with hooks and extensionless runtime imports.
import { ValoMark } from "../../../lib/web-ui/src/valo-mark";
import { ArrowLeft, Grid2x2 } from "lucide-react";
import { CalculatorLoading } from "./calculator-loading";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// This static chrome is rendered by Vite, never shipped as client JavaScript.
export function CalculatorDocument() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-lime-300 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#071a1c] focus:shadow-sm ${FOCUS_RING}`}
      >
        Skip to content
      </a>
      <header className="border-b border-white/10 bg-[#071a1c] text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4 sm:gap-3 sm:px-6">
          <a
            href="/"
            aria-label="Valo home"
            className={`inline-flex items-center gap-3 rounded-md ${FOCUS_RING}`}
          >
            <div className="text-white">
              <ValoMark className="h-8 w-8" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-semibold leading-none">Valo</p>
              <p className="text-xs leading-tight text-white/70">
                Penalty planning tool
              </p>
            </div>
          </a>
          <a
            href="/"
            data-testid="link-back-to-website"
            aria-label="Back to website"
            className={`ml-auto inline-flex size-9 items-center justify-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white sm:size-auto sm:px-3 sm:py-2 ${FOCUS_RING}`}
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            <span className="hidden text-sm font-semibold sm:inline">
              Back to website
            </span>
          </a>
          <a
            href="/login"
            data-testid="link-all-apps"
            aria-label="Open Valo workspaces"
            className={`inline-flex size-9 items-center justify-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white sm:size-auto sm:px-3 sm:py-2 ${FOCUS_RING}`}
          >
            <Grid2x2 className="h-5 w-5" aria-hidden="true" />
            <span className="hidden text-sm font-semibold sm:inline">
              Workspaces
            </span>
          </a>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-8 focus:outline-none sm:px-6 sm:py-10"
      >
        <div id="root">
          <CalculatorLoading />
        </div>
        <noscript>JavaScript is required to calculate an estimate.</noscript>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-6 pb-20 text-xs text-muted-foreground sm:px-6 lg:pb-6">
          &copy; <span id="copyright-year">{new Date().getFullYear()}</span>{" "}
          Valo. Estimates only - not legal or tax advice.
        </div>
      </footer>
    </div>
  );
}
