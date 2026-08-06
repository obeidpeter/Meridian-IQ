import { registerSweep } from "../pipeline/pipeline";
import { sweepWhtReminders } from "./reminders";

// The WHT credit-note chase sweep rides the minute loop UNWRAPPED (the
// filings/register.ts cadence for its reminder sweep): cheap when nothing is
// due — an indexed scan plus the sent-ledger's NOT EXISTS — and a chase
// deadline crossing its threshold should nudge within the minute, not the
// hour. Kept out of reminders.ts so that module stays importable by
// node --test without the pipeline worker's dependency graph.
registerSweep(() => sweepWhtReminders());
