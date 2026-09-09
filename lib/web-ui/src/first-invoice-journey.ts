import type { TodaySetupStepView } from "./today-types";

const invoiceStages: Record<string, { label: string; order: number }> = {
  two_factor: { label: "Access", order: 0 },
  consent: { label: "Access", order: 1 },
  first_client: { label: "Business", order: 2 },
  business_identity: { label: "Business", order: 3 },
  first_customer: { label: "Customer", order: 4 },
  first_invoice: { label: "Draft", order: 5 },
  invoice_validation: { label: "Validation", order: 6 },
  invoice_submission: { label: "Submission", order: 7 },
  invoice_evidence: { label: "Evidence", order: 8 },
};

// These are recommendation prerequisites, not authorization or mutation gates.
// Only steps actually returned by the server participate; an omitted feature
// must never become a new client-side requirement.
const prerequisites: Record<string, string[]> = {
  business_identity: ["first_client"],
  first_customer: ["first_client"],
  first_invoice: ["first_client", "first_customer"],
  invoice_validation: [
    "first_client",
    "business_identity",
    "first_customer",
    "first_invoice",
  ],
  invoice_submission: [
    "first_client",
    "business_identity",
    "first_customer",
    "first_invoice",
    "invoice_validation",
  ],
  invoice_evidence: ["first_invoice"],
};

export function firstInvoiceJourney(setup: TodaySetupStepView[]) {
  const isInvoiceJourney = setup.some((step) =>
    ["first_invoice", "invoice_validation", "invoice_evidence"].includes(
      step.id,
    ),
  );
  const ordered = isInvoiceJourney
    ? [...setup].sort(
        (a, b) =>
          (invoiceStages[a.id]?.order ?? 9) - (invoiceStages[b.id]?.order ?? 9),
      )
    : setup;
  const steps = ordered.map((step) => {
    const waitingFor = step.complete
      ? []
      : (Object.hasOwn(prerequisites, step.id)
          ? prerequisites[step.id]
          : []
        ).flatMap((id) => {
          const prerequisite = setup.find((candidate) => candidate.id === id);
          return prerequisite && !prerequisite.complete ? [prerequisite] : [];
        });
    const blockedReason = step.complete
      ? null
      : step.blockedReason?.trim() ||
        (!step.href.trim()
          ? "No destination is available for this step."
          : null);
    return {
      ...step,
      stage: isInvoiceJourney ? invoiceStages[step.id]?.label : undefined,
      waitingFor,
      blockedReason,
    };
  });
  const completed = steps.filter((step) => step.complete).length;
  const next = steps.find(
    (step) => !step.complete && !step.blockedReason && !step.waitingFor.length,
  );
  return {
    steps,
    next,
    completed,
    total: steps.length,
    percent: steps.length ? Math.round((completed / steps.length) * 100) : null,
    isInvoiceJourney,
    blocked: steps.filter(
      (step) =>
        !step.complete && (step.blockedReason || step.waitingFor.length),
    ).length,
  };
}
