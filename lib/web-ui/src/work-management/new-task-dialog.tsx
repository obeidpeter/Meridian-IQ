import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, Plus, X } from "lucide-react";
import { LiveStatus } from "../live-status";
import { assigneesFor } from "./helpers";
import type {
  CollaborativeAssigneeOption,
  CollaborativeClientOption,
  CollaborativeWorkPriority,
} from "./types";
import type { TaskComposer } from "./use-task-composer";

export function NewTaskDialog({
  composer,
  clients,
  assignees,
  busy,
}: {
  composer: TaskComposer;
  clients: CollaborativeClientOption[];
  assignees: CollaborativeAssigneeOption[];
  busy: boolean;
}) {
  const {
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
  } = composer;
  return (
    <Dialog.Root open={newOpen} onOpenChange={setNewOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="mi-dialog-overlay" />
        <Dialog.Content className="mi-work-dialog">
          <div className="mi-work-dialog__heading">
            <div>
              <Dialog.Title>New task</Dialog.Title>
              <Dialog.Description>
                Give the work a clear outcome, owner context and due date.
              </Dialog.Description>
              <LiveStatus className="mi-work-dialog__saved">
                {hasDraft ? "Draft saved on this device." : null}
              </LiveStatus>
            </div>
            <Dialog.Close
              className="mi-icon-button"
              aria-label="Close new task dialog"
            >
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <form onSubmit={submitNew}>
            {clients.length > 0 ? (
              <label>
                Client
                <select
                  value={clientPartyId}
                  onChange={(event) => {
                    const nextClient = event.target.value;
                    setClientPartyId(nextClient);
                    if (
                      assignedTo &&
                      !assigneesFor(assignees, nextClient || null).some(
                        (assignee) => assignee.id === assignedTo,
                      )
                    ) {
                      setAssignedTo("");
                    }
                  }}
                >
                  <option value="">Firm-wide task</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {assignees.length > 0 ? (
              <label>
                Owner <span>Optional</span>
                <select
                  value={assignedTo}
                  onChange={(event) => setAssignedTo(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {newTaskAssignees.map((assignee) => (
                    <option key={assignee.id} value={assignee.id}>
                      {assignee.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Task title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                minLength={2}
                maxLength={160}
                required
                autoFocus
                placeholder="e.g. Confirm July VAT return"
              />
            </label>
            <label>
              Context <span>Optional</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="What outcome is needed?"
              />
            </label>
            <div className="mi-work-dialog__row">
              <label>
                Priority
                <select
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as CollaborativeWorkPriority)
                  }
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label>
                Due date <span>Optional</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </label>
            </div>
            <div className="mi-work-dialog__actions">
              <Dialog.Close className="mi-button-quiet" type="button">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                className="mi-button-primary"
                aria-busy={busy || undefined}
                aria-disabled={busy || title.trim().length < 2 || undefined}
              >
                {busy ? (
                  <Loader2 className="is-spinning" aria-hidden="true" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                Create task
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
