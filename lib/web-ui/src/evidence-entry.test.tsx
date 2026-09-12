// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EvidenceHub } from "./evidence-lazy";
import type { EvidenceHubProps } from "./evidence-hub";

const mounted = vi.hoisted(() => vi.fn());
vi.mock("./evidence-hub", async () => {
  const { useEffect } = await import("react");
  return {
    EvidenceHub: ({ invoiceId }: EvidenceHubProps) => {
      useEffect(() => {
        mounted();
      }, []);
      return <p>Evidence for {invoiceId}</p>;
    },
  };
});
afterEach(cleanup);

test("the compatibility entry forwards props without remounting the loaded feature", async () => {
  const props = { invoiceId: "invoice-one" } as EvidenceHubProps;
  const view = render(<EvidenceHub {...props} />);
  await screen.findByText("Evidence for invoice-one");
  view.rerender(<EvidenceHub {...props} invoiceId="invoice-two" />);
  expect(screen.getByText("Evidence for invoice-two")).toBeTruthy();
  expect(mounted).toHaveBeenCalledOnce();
});
