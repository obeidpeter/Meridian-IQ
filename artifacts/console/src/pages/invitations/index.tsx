// The invitations page (R126 split the 986-line file into this shell, the
// state hook, the four cards and the two confirm dialogs). The route
// (App.tsx) keeps importing "@/pages/invitations": this module is the page's
// surface.

import { WorkspaceHeader } from "@workspace/web-ui";
import { useInvitations } from "./use-invitations";
import { InviteFormCard } from "./invite-form-card";
import { PasswordResetCard } from "./password-reset-card";
import { InviteTokenCard } from "./invite-token-card";
import { InvitationsListCard } from "./invitations-list-card";
import { DismissTokenDialog, RevokeDialog } from "./dialogs";

export function Invitations() {
  const state = useInvitations();
  const { isOperator, created } = state;

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Team & access"
        title="Invitations"
        titleTestId="text-page-title"
        description={
          isOperator
            ? "Create a firm, then invite its first firm admin. Share the one-time link yourself; nothing is emailed. The admin can then invite teammates and business users."
            : "Invite a teammate or client into your firm. Each invite issues a one-time link to set a password and join — you share the link yourself; pending invites can be revoked before they are accepted."
        }
      />

      <InviteFormCard state={state} />

      {isOperator && <PasswordResetCard state={state} />}

      {created && <InviteTokenCard state={state} created={created} />}

      <InvitationsListCard state={state} />

      <DismissTokenDialog state={state} />

      <RevokeDialog state={state} />
    </div>
  );
}
