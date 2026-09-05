import { lazy, Suspense, useRef, useState } from "react";
import { RouteErrorBoundary } from "@workspace/web-ui";
import { CalculatorLoading } from "./calculator-loading";

export function CalculatorRoot() {
  const chunkFailed = useRef(false);
  const loadCalculator = () =>
    import("./App").catch((error: unknown) => {
      chunkFailed.current = true;
      throw error;
    });
  const [Calculator, setCalculator] = useState(() => lazy(loadCalculator));
  return (
    <RouteErrorBoundary
      homeHref="/"
      onRetry={() => {
        // Browsers cache failed module imports until document navigation.
        if (chunkFailed.current) window.location.reload();
        else setCalculator(() => lazy(loadCalculator));
      }}
    >
      <Suspense fallback={<CalculatorLoading />}>
        <Calculator />
      </Suspense>
    </RouteErrorBoundary>
  );
}
