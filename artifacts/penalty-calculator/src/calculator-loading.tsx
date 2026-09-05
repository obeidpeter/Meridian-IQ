/** @jsxRuntime automatic */
export function CalculatorLoading() {
  return (
    <>
      <h1 className="text-2xl font-extrabold text-slate-950 md:text-3xl">
        E-invoicing penalty estimator
      </h1>
      <p role="status" className="py-8 text-sm text-muted-foreground">
        Loading calculator
      </p>
      <div aria-hidden="true" className="h-80 rounded bg-muted" />
    </>
  );
}
