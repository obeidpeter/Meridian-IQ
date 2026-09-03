import type { Rail } from "@workspace/db";
import type { CanonicalInvoice } from "../../invoice/canonical";
import type { RailTransport, StampResult } from "../adapter";
import {
  FaultScript,
  classifiedResult,
  deterministicStamp,
  type RailFault,
  type RailFaultOutcome,
} from "../faults";

// The scripted in-process fake rail (R95): the test double every adapter and
// pipeline suite binds. Per invoice number it can accept, reject with a code,
// report a duplicate (recoverable or not), time out, rate-limit, be
// unavailable, refuse credentials or answer garbage — the same vocabulary the
// conformance fake-rail server speaks on the wire, so a pipeline scenario
// scripted here reads identically as an e2e scenario scripted there. It
// answers the CLASSIFIED outcome instantly (a "timeout" is RAIL_TIMEOUT
// without a wait) and keeps a call log for assertions. Unscripted invoices
// are accepted with simulator-shaped deterministic stamps.

export interface ScriptedCall {
  op: "submit" | "lookup";
  rail: Rail;
  invoiceNumber: string;
  idempotencyKey: string;
  outcome: RailFaultOutcome | "lookup_hit" | "lookup_miss";
}

export interface ScriptedRail extends RailTransport {
  /** Queue a fault for an invoice number ("*" = any invoice not otherwise scripted). */
  script(invoiceNumber: string, fault: RailFault): void;
  /** Make lookup answer a stamp for this invoice (default: the deterministic one). */
  hold(invoiceNumber: string, stamp?: Partial<StampResult>): void;
  readonly calls: ScriptedCall[];
  reset(): void;
}

export interface ScriptedRailOptions {
  name?: string;
  environment?: string;
  /** The rails this transport serves (default: both). */
  rails?: Rail[];
}

export function scriptedRail(opts: ScriptedRailOptions = {}): ScriptedRail {
  const name = opts.name ?? "scripted";
  const environment = opts.environment ?? "sandbox";
  const secret = `scripted-rail-${name}`;
  const faults = new FaultScript();
  const held = new Map<string, Partial<StampResult>>();
  const calls: ScriptedCall[] = [];

  const transport: ScriptedRail = {
    name,
    environment,
    ...(opts.rails ? { rails: [...opts.rails] } : {}),
    calls,
    script(invoiceNumber, fault) {
      faults.script(invoiceNumber, fault);
    },
    hold(invoiceNumber, stamp) {
      held.set(invoiceNumber, stamp ?? {});
    },
    reset() {
      faults.reset();
      held.clear();
      calls.length = 0;
    },
    async submit(rail: Rail, inv: CanonicalInvoice, idempotencyKey: string) {
      const fault = faults.next(inv.invoiceNumber) ?? { outcome: "accept" };
      if (fault.outcome === "duplicate" && fault.holdsStamp && !held.has(inv.invoiceNumber)) {
        held.set(inv.invoiceNumber, {});
      }
      calls.push({
        op: "submit",
        rail,
        invoiceNumber: inv.invoiceNumber,
        idempotencyKey,
        outcome: fault.outcome,
      });
      return classifiedResult(rail, fault, {
        inv,
        idempotencyKey,
        secret,
        provider: name,
        environment,
      });
    },
    async lookup(rail: Rail, inv: CanonicalInvoice, idempotencyKey: string) {
      const stamp = held.get(inv.invoiceNumber);
      calls.push({
        op: "lookup",
        rail,
        invoiceNumber: inv.invoiceNumber,
        idempotencyKey,
        outcome: stamp ? "lookup_hit" : "lookup_miss",
      });
      if (!stamp) return null;
      return {
        status: "accepted",
        rail,
        ...deterministicStamp(inv, idempotencyKey, secret),
        raw: { lookedUp: true },
        provider: name,
        environment,
        ...stamp,
      };
    },
  };
  return transport;
}
