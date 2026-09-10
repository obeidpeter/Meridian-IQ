export type CollaborativeWorkStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done";
export type CollaborativeWorkPriority = "low" | "normal" | "high" | "urgent";

export interface CollaborativeWorkItem {
  id: string;
  clientPartyId: string | null;
  clientName: string | null;
  title: string;
  description: string | null;
  status: CollaborativeWorkStatus;
  priority: CollaborativeWorkPriority;
  dueAt: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  createdByName: string | null;
  href: string | null;
  version: number;
  updatedAt: string;
}

export interface CollaborativeWorkComment {
  id: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface CollaborativeClientOption {
  id: string;
  name: string;
}

export interface CollaborativeAssigneeOption {
  id: string;
  name: string;
  clientPartyId?: string | null;
}

export interface CreateCollaborativeWorkInput {
  clientRequestId: string;
  clientPartyId?: string;
  title: string;
  description?: string;
  priority: CollaborativeWorkPriority;
  dueAt?: string;
  assignedTo?: string;
}
