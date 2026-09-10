import { useEffect, useRef, useState, type FormEvent } from "react";
import { assigneesFor } from "./helpers";
import {
  adoptLegacyDraft,
  readAttempt,
  readDraft,
  type WorkAttempt,
  type WorkDraft,
} from "./task-draft";
import type {
  CollaborativeAssigneeOption,
  CollaborativeWorkPriority,
  CreateCollaborativeWorkInput,
} from "./types";

export function useTaskComposer({
  draftStorageKey,
  legacyDraftStorageKey,
  assignees,
  busy,
  openNewInitially,
  onCreate,
  setLocalError,
}: {
  draftStorageKey?: string;
  legacyDraftStorageKey?: string;
  assignees: CollaborativeAssigneeOption[];
  busy: boolean;
  openNewInitially: boolean;
  onCreate: (input: CreateCollaborativeWorkInput) => Promise<void>;
  setLocalError: (message: string | null) => void;
}) {
  const [initialDraft] = useState(() => {
    adoptLegacyDraft(legacyDraftStorageKey, draftStorageKey);
    return readDraft(draftStorageKey);
  });
  const [newOpen, setNewOpen] = useState(openNewInitially);
  const [title, setTitle] = useState(initialDraft.title);
  const [description, setDescription] = useState(initialDraft.description);
  const [clientPartyId, setClientPartyId] = useState(
    initialDraft.clientPartyId,
  );
  const [priority, setPriority] = useState<CollaborativeWorkPriority>(
    initialDraft.priority,
  );
  const [dueDate, setDueDate] = useState(initialDraft.dueDate);
  const [assignedTo, setAssignedTo] = useState(initialDraft.assignedTo);
  const creatingTask = useRef(false);
  const taskAttempt = useRef<WorkAttempt | null>(readAttempt(draftStorageKey));
  const loadedDraftKey = useRef(draftStorageKey);

  const newTaskAssignees = assigneesFor(assignees, clientPartyId || null);
  const hasDraft = Boolean(
    title || description || clientPartyId || dueDate || assignedTo,
  );

  useEffect(() => {
    if (!draftStorageKey || loadedDraftKey.current === draftStorageKey) return;
    loadedDraftKey.current = draftStorageKey;
    adoptLegacyDraft(legacyDraftStorageKey, draftStorageKey);
    taskAttempt.current = readAttempt(draftStorageKey);
    if (hasDraft) return;
    const draft = readDraft(draftStorageKey);
    setTitle(draft.title);
    setDescription(draft.description);
    setClientPartyId(draft.clientPartyId);
    setPriority(draft.priority);
    setDueDate(draft.dueDate);
    setAssignedTo(draft.assignedTo);
  }, [draftStorageKey, hasDraft, legacyDraftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey || typeof window === "undefined") return;
    const draft: WorkDraft = {
      title,
      description,
      clientPartyId,
      priority,
      dueDate,
      assignedTo,
    };
    try {
      if (title || description || clientPartyId || dueDate || assignedTo) {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
      } else {
        window.localStorage.removeItem(draftStorageKey);
      }
    } catch {
      // Storage may be unavailable in private or locked-down browser modes.
    }
  }, [
    assignedTo,
    clientPartyId,
    description,
    draftStorageKey,
    dueDate,
    priority,
    title,
  ]);

  const submitNew = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingTask.current || busy || title.trim().length < 2) return;
    creatingTask.current = true;
    setLocalError(null);
    try {
      const input = {
        ...(clientPartyId ? { clientPartyId } : {}),
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        priority,
        ...(dueDate
          ? { dueAt: new Date(`${dueDate}T12:00:00`).toISOString() }
          : {}),
        ...(assignedTo ? { assignedTo } : {}),
      };
      const signature = JSON.stringify(input);
      if (taskAttempt.current?.signature !== signature) {
        taskAttempt.current = { signature, id: crypto.randomUUID() };
      }
      if (draftStorageKey) {
        try {
          window.localStorage.setItem(
            `${draftStorageKey}:attempt`,
            JSON.stringify(taskAttempt.current),
          );
        } catch {
          // The in-memory key still protects retries until the page is closed.
        }
      }
      await onCreate({
        clientRequestId: taskAttempt.current.id,
        ...input,
      });
      taskAttempt.current = null;
      setTitle("");
      setDescription("");
      setClientPartyId("");
      setPriority("normal");
      setDueDate("");
      setAssignedTo("");
      if (draftStorageKey) {
        try {
          window.localStorage.removeItem(draftStorageKey);
          window.localStorage.removeItem(`${draftStorageKey}:attempt`);
        } catch {
          // State has still been cleared when storage is unavailable.
        }
      }
      setNewOpen(false);
    } catch (caught) {
      setLocalError(
        caught instanceof Error
          ? caught.message
          : "The task could not be created.",
      );
    } finally {
      creatingTask.current = false;
    }
  };

  return {
    newOpen,
    setNewOpen,
    title,
    setTitle,
    description,
    setDescription,
    clientPartyId,
    setClientPartyId,
    priority,
    setPriority,
    dueDate,
    setDueDate,
    assignedTo,
    setAssignedTo,
    hasDraft,
    newTaskAssignees,
    submitNew,
  };
}

export type TaskComposer = ReturnType<typeof useTaskComposer>;
