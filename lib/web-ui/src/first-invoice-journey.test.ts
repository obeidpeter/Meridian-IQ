import { expect, test } from "vitest";
import { firstInvoiceJourney } from "./first-invoice-journey";
import type { TodaySetupStepView } from "./today";

function step(id: string, complete = false): TodaySetupStepView {
  return { id, label: id, description: id, href: `/${id}`, complete };
}

test("only returned steps participate and the input is never reordered in place", () => {
  const setup = [step("first_invoice"), step("consent"), step("two_factor")];
  const journey = firstInvoiceJourney(setup);
  expect(journey.steps.map((item) => item.id)).toEqual([
    "two_factor",
    "consent",
    "first_invoice",
  ]);
  expect(setup.map((item) => item.id)).toEqual([
    "first_invoice",
    "consent",
    "two_factor",
  ]);
  expect(
    journey.steps.find((item) => item.id === "first_invoice")?.waitingFor,
  ).toEqual([]);
});

test("customer and draft recommendations wait on returned persisted prerequisites", () => {
  const journey = firstInvoiceJourney([
    step("first_invoice"),
    step("invoice_validation"),
    step("first_customer"),
    step("first_client"),
  ]);
  expect(journey.next?.id).toBe("first_client");
  expect(journey.blocked).toBe(3);
  expect(
    journey.steps
      .find((item) => item.id === "invoice_validation")
      ?.waitingFor.map((item) => item.id),
  ).toEqual(["first_client", "first_customer", "first_invoice"]);
});

test("ERP, reconciliation and access choices are not hard validation prerequisites", () => {
  const journey = firstInvoiceJourney([
    step("two_factor"),
    step("consent"),
    step("first_connection"),
    step("first_statement"),
    step("first_invoice", true),
    step("invoice_validation"),
  ]);
  expect(
    journey.steps.find((item) => item.id === "invoice_validation")?.waitingFor,
  ).toEqual([]);
  expect(journey.blocked).toBe(0);
});

test("evidence can proceed without submission, validation or live provider completion", () => {
  const journey = firstInvoiceJourney([
    step("first_invoice", true),
    {
      ...step("invoice_validation"),
      blockedReason: "Business details need correction.",
    },
    {
      ...step("invoice_submission"),
      blockedReason: "Another approver is required.",
    },
    step("invoice_evidence"),
  ]);
  expect(journey.next?.id).toBe("invoice_evidence");
  expect(journey.completed).toBe(1);
});

test("empty, blocked and complete are distinct, including an unavailable destination", () => {
  expect(firstInvoiceJourney([])).toMatchObject({
    percent: null,
    total: 0,
    next: undefined,
  });
  expect(
    firstInvoiceJourney([{ ...step("first_invoice"), href: " " }]),
  ).toMatchObject({
    percent: 0,
    blocked: 1,
    next: undefined,
  });
  expect(firstInvoiceJourney([step("first_invoice", true)])).toMatchObject({
    percent: 100,
    completed: 1,
    blocked: 0,
    next: undefined,
  });
});

test("unknown roles and future steps keep the server order and destinations", () => {
  const setup = [
    step("review_queue"),
    step("first_confirmation"),
    step("future_step"),
    step("toString"),
  ];
  const journey = firstInvoiceJourney(setup);
  expect(journey.isInvoiceJourney).toBe(false);
  expect(journey.steps.map((item) => item.id)).toEqual(
    setup.map((item) => item.id),
  );
  expect(journey.steps.map((item) => item.href)).toEqual(
    setup.map((item) => item.href),
  );
});

test("submission waits on current consent, approval and service, without blocking evidence", () => {
  const journey = firstInvoiceJourney([
    step("first_invoice", true),
    step("invoice_validation", true),
    step("invoice_consent"),
    step("invoice_approval"),
    {
      ...step("invoice_service"),
      blockedReason: "Only test processing is available.",
    },
    step("invoice_submission"),
    step("invoice_acknowledgement"),
    step("invoice_evidence"),
  ]);
  expect(journey.next?.id).toBe("invoice_consent");
  expect(
    journey.steps
      .find((item) => item.id === "invoice_submission")
      ?.waitingFor.map((item) => item.id),
  ).toEqual(["invoice_consent", "invoice_approval", "invoice_service"]);
  expect(
    journey.steps
      .find((item) => item.id === "invoice_acknowledgement")
      ?.waitingFor.map((item) => item.id),
  ).toEqual(["invoice_submission"]);
  expect(
    journey.steps.find((item) => item.id === "invoice_evidence")?.waitingFor,
  ).toEqual([]);
});
