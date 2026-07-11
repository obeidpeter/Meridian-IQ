import { registerSweep } from "../pipeline/pipeline";
import { sweepPushReceipts } from "./push";

// Wires the push-receipt straggler sweep onto the shared compliance-sweep
// loop (runs every minute; the sweep's 15-minute age filter makes the
// frequent cadence cost nothing). Kept separate from push.ts so the push
// module stays importable by node --test without dragging in the pipeline
// worker's dependency graph (whose extensionless imports node cannot load).
registerSweep(() => sweepPushReceipts());
