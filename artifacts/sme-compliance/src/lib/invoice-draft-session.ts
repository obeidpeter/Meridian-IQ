import {
  emptyInvoiceDraft,
  INVOICE_DRAFT_TTL_MS,
  removeDraftRecovery,
  saveDraftRecovery,
  type DraftRecovery,
  type DraftState,
} from "./invoice-draft";
import { draftHasWork } from "./invoice-lines";
import { errorStatus } from "./errors";
import type { InvoiceDraftApi, ServerInvoiceDraft } from "./invoice-draft-api";
import type { InvoiceInput } from "@workspace/api-client-react";
import {
  readInvoiceSubmission,
  writeInvoiceSubmission,
  submissionStorageKey,
  type InvoiceSubmission,
} from "./invoice-submission";

export type DraftSaveStatus =
  | "loading"
  | "empty"
  | "saving"
  | "saved"
  | "local"
  | "conflict"
  | "error";
export interface DraftSessionState {
  draft: DraftState;
  revision: number;
  status: DraftSaveStatus;
  localSaved: boolean;
  dirty: boolean;
  submission?: InvoiceSubmission;
}
const same = (a: DraftState, b: DraftState) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Server compare-and-set is authoritative; every tab owns a separate recovery file. */
export class InvoiceDraftSession {
  readonly writerId = crypto.randomUUID();
  state: DraftSessionState;
  private listeners = new Set<() => void>();
  private pending?: DraftRecovery["pending"];
  private flight?: Promise<boolean>;
  private closed = false;
  private generation = 0;
  private active = true;
  private lifecycle = 0;
  private readSequence = 0;
  private abort = new AbortController();
  constructor(
    readonly scopeKey: string,
    readonly id: string,
    private api: InvoiceDraftApi,
    recovery?: DraftRecovery,
    private ownerIsCurrent: () => boolean = () => true,
  ) {
    const submission = scopeKey
      ? readInvoiceSubmission(scopeKey, id)
      : undefined;
    this.state = {
      draft:
        submission?.status === "pending"
          ? submission.draft
          : (recovery?.draft ?? emptyInvoiceDraft()),
      revision: recovery?.revision ?? 0,
      status: "loading",
      localSaved: false,
      dirty: !!recovery,
      submission,
    };
    this.pending = recovery?.pending;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  canLeave = () => this.closed || !this.state.dirty || this.state.localSaved;
  isCurrent = () => this.active && this.ownerIsCurrent();
  isActive = () => !this.closed && this.isCurrent();
  captureLifecycle = () => {
    const lifecycle = this.lifecycle;
    return () => this.isCurrent() && lifecycle === this.lifecycle;
  };
  private current(lifecycle: number) {
    return this.isActive() && lifecycle === this.lifecycle;
  }
  // Effect replay may reactivate this object; old async work keeps its old epoch.
  activate() {
    if (this.closed || !this.ownerIsCurrent()) return false;
    if (!this.active) {
      this.active = true;
      this.abort = new AbortController();
      this.update({ status: "loading" });
    }
    return true;
  }
  deactivate(preserveRecovery = true) {
    if (preserveRecovery && this.isActive()) this.persist();
    this.active = false;
    this.lifecycle++;
    this.abort.abort();
    this.flight = undefined;
  }
  invalidate = () => {
    this.deactivate(false);
    this.closed = true;
  };
  private update(patch: Partial<DraftSessionState>) {
    if (!this.isActive()) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  refreshSubmission = () => {
    if (!this.isActive()) return this.state.submission;
    const submission = readInvoiceSubmission(this.scopeKey, this.id);
    if (submission) {
      this.generation++;
      this.pending = undefined;
      this.update({
        submission,
        dirty: false,
        status: "local",
        ...(submission.status === "pending" ? { draft: submission.draft } : {}),
      });
    }
    return submission;
  };
  async prepareSubmission(body: InvoiceInput, check: () => void) {
    const prepare = () => {
      check();
      if (!this.isActive())
        throw new DOMException("Inactive invoice draft", "AbortError");
      const existing = this.refreshSubmission();
      if (existing) return { submission: existing, firstDispatch: false };
      const submission: InvoiceSubmission = {
        status: "pending",
        key: `invoice-create:${this.id}`,
        body: structuredClone(body),
        draft: structuredClone(this.state.draft),
      };
      writeInvoiceSubmission(this.scopeKey, this.id, submission);
      this.generation++;
      this.pending = undefined;
      this.update({ submission, draft: submission.draft, dirty: false });
      this.persist();
      return { submission, firstDispatch: true };
    };
    return typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(
          submissionStorageKey(this.scopeKey, this.id),
          prepare,
        )
      : prepare();
  }
  rejectSubmission() {
    if (!this.isActive()) return;
    localStorage.removeItem(submissionStorageKey(this.scopeKey, this.id));
    this.update({ submission: undefined });
  }
  confirmSubmission(invoiceId: string) {
    if (!this.isActive()) return;
    const submission: InvoiceSubmission = {
      status: "succeeded",
      key: `invoice-create:${this.id}`,
      invoiceId,
    };
    // Keep a small receipt even when deleting the server draft later fails.
    writeInvoiceSubmission(this.scopeKey, this.id, submission);
    this.update({ submission });
  }
  persist = () => {
    if (!this.isActive()) return;
    if (!draftHasWork(this.state.draft)) {
      removeDraftRecovery(this.scopeKey, this);
      return;
    }
    const now = new Date();
    const localSaved = saveDraftRecovery(this.scopeKey, {
      version: 2,
      id: this.id,
      writerId: this.writerId,
      draft: this.state.draft,
      revision: this.state.revision,
      savedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVOICE_DRAFT_TTL_MS).toISOString(),
      pending: this.pending,
    });
    if (localSaved !== this.state.localSaved) this.update({ localSaved });
  };
  edit = (next: DraftState | ((draft: DraftState) => DraftState)) => {
    if (!this.isActive() || this.state.status === "loading") return;
    if (this.refreshSubmission()) return;
    this.generation++;
    this.update({
      draft: typeof next === "function" ? next(this.state.draft) : next,
      dirty: true,
      status: this.state.status === "conflict" ? "conflict" : "local",
    });
    this.persist();
  };
  private accept(row: ServerInvoiceDraft) {
    const unchanged = same(this.state.draft, row.draft);
    this.pending = undefined;
    this.update({
      revision: row.revision,
      dirty: !unchanged,
      status: unchanged ? "saved" : "local",
    });
    this.persist();
  }
  async load() {
    if (!this.isActive()) return;
    if (this.refreshSubmission()) return;
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const read = ++this.readSequence;
    try {
      const row = await this.api.get(this.id, this.abort.signal);
      if (
        !this.current(lifecycle) ||
        generation !== this.generation ||
        read !== this.readSequence
      )
        return;
      if (
        this.pending?.writeId === row.writeId &&
        same(this.pending.draft, row.draft)
      ) {
        this.accept(row);
        return;
      }
      if (this.state.dirty && this.state.revision !== row.revision) {
        this.update({ status: "conflict" });
        this.persist();
        return;
      }
      if (this.state.dirty) {
        if (same(this.state.draft, row.draft)) this.accept(row);
        else {
          this.update({ status: "local" });
          this.persist();
        }
        return;
      }
      this.update({
        draft: row.draft,
        revision: row.revision,
        dirty: false,
        status: "saved",
      });
    } catch (error) {
      if (
        !this.current(lifecycle) ||
        generation !== this.generation ||
        read !== this.readSequence
      )
        return;
      this.update({
        status:
          errorStatus(error) === 404
            ? this.state.revision > 0
              ? "conflict"
              : this.state.dirty
                ? "local"
                : "empty"
            : "error",
      });
      if (this.state.dirty) this.persist();
    }
  }
  save = (): Promise<boolean> => {
    if (!this.isActive()) return Promise.resolve(false);
    if (this.refreshSubmission()) return Promise.resolve(false);
    if (this.flight) return this.flight;
    if (this.state.status === "conflict" || this.state.status === "loading")
      return Promise.resolve(false);
    if (!this.state.dirty) return Promise.resolve(true);
    const lifecycle = this.lifecycle;
    const signal = this.abort.signal;
    const execute = async () => {
      while (this.state.dirty && this.current(lifecycle)) {
        this.pending ??= {
          writeId: crypto.randomUUID(),
          expectedRevision: this.state.revision,
          draft: this.state.draft,
        };
        this.update({ status: "saving" });
        this.persist();
        try {
          if (!this.current(lifecycle)) return false;
          const saved = await this.api.save(this.id, this.pending, signal);
          if (!this.current(lifecycle)) return false;
          this.accept(saved);
          if (!this.current(lifecycle)) return false;
          try {
            window.localStorage.setItem(
              `${this.scopeKey}:${this.id}:notice`,
              JSON.stringify({
                writerId: this.writerId,
                revision: saved.revision,
              }),
            );
          } catch {
            /* Server revisions still protect competing writers. */
          }
        } catch (error) {
          if (!this.current(lifecycle)) return false;
          this.update({
            status: errorStatus(error) === 409 ? "conflict" : "error",
          });
          this.persist();
          return false;
        }
      }
      return this.current(lifecycle);
    };
    const flight = execute().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  };
  externalChange() {
    if (!this.isActive() || this.flight) return;
    if (this.state.dirty) this.update({ status: "conflict" });
    else void this.load();
  }
  async reload() {
    if (!this.isActive()) return false;
    if (this.refreshSubmission()) return false;
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const read = ++this.readSequence;
    const current = () =>
      this.current(lifecycle) &&
      generation === this.generation &&
      read === this.readSequence;
    if (this.flight) await this.flight;
    if (!current()) return false;
    let row: ServerInvoiceDraft;
    try {
      row = await this.api.get(this.id, this.abort.signal);
    } catch (error) {
      if (!current()) return false;
      throw error;
    }
    if (!current()) return false;
    this.generation++;
    this.pending = undefined;
    this.update({
      draft: row.draft,
      revision: row.revision,
      dirty: false,
      status: "saved",
    });
    this.persist();
    return true;
  }
  async discard() {
    if (!this.isActive()) return false;
    const submission = this.refreshSubmission();
    if (submission && submission.status !== "succeeded") return false;
    const lifecycle = this.lifecycle;
    if (this.flight) await this.flight;
    if (!this.current(lifecycle)) return false;
    try {
      await this.api.remove(this.id, this.state.revision, this.abort.signal);
    } catch (error) {
      if (!this.current(lifecycle)) return false;
      throw error;
    }
    if (!this.current(lifecycle)) return false;
    this.closed = true;
    this.abort.abort();
    removeDraftRecovery(this.scopeKey, this);
    try {
      window.localStorage.setItem(
        `${this.scopeKey}:${this.id}:notice`,
        JSON.stringify({ writerId: this.writerId, deleted: true }),
      );
    } catch {
      /* Optional notification only. */
    }
    return true;
  }
  complete() {
    if (!this.isActive()) return;
    this.closed = true;
    this.abort.abort();
    removeDraftRecovery(this.scopeKey, this);
  }
}
