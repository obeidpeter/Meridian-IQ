import { useState, type FormEvent } from "react";
import {
  useListInvitations,
  useCreateInvitation,
  useRevokeInvitation,
  useCreatePasswordReset,
  useCreateFirm,
  useListFirms,
  useGetPortfolio,
  useGetMe,
  getListInvitationsQueryKey,
  getListFirmsQueryKey,
  getGetPortfolioQueryKey,
} from "@workspace/api-client-react";
import type {
  Invitation,
  InvitationWithToken,
  CreateInvitationInput,
  CreateInvitationInputRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { errorStatus, serverErrorToast } from "@/lib/errors";
import {
  acceptInviteLink,
  resetPasswordLink,
  readInvitationPrefill,
} from "@/lib/invitations";

// IDN-01 self-serve invitations: a firm admin invites a teammate or client into
// their firm, and — on creation — is shown the ONE-TIME token plus a ready-to-
// share accept link. The server (POST /api/invitations) requires a clientPartyId
// for client_user invites (scoped to a party the firm engages) and rejects one
// for the firm roles, so the form only sends clientPartyId for client_user.

// Ordered most- to least-privileged among the invitable firm roles, client last.
const ROLE_OPTIONS: CreateInvitationInputRole[] = [
  "firm_admin",
  "firm_staff",
  "client_user",
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Everything the invitations page holds and does (R126 moved it out of the
// page shell): the queries, the four mutations, every form field and the
// submit / revoke / provision / reset / copy flows. The shell calls it once
// and hands the bag to the cards and dialogs, so nothing about hook order
// changed in the split; the prefill initializer still reads
// window.location.search once on mount.
export function useInvitations() {
  usePageTitle("Invitations");
  const { data: me } = useGetMe();
  const canReadPortfolio = (me?.capabilities ?? []).includes(
    "console.portfolio.read",
  );
  // identity.write marks the operator: invitations then target a chosen firm
  // (the new-firm bootstrap path) instead of the caller's own.
  const isOperator = (me?.capabilities ?? []).includes("identity.write");

  const { data: invitations, isLoading, error, refetch } = useListInvitations();
  // The firm's engaged clients are exactly the valid targets for a client
  // invitation (the server validates clientPartyId against an engagement), so
  // the portfolio's client list drives the picker. Gated on the capability so
  // an operator-only principal never fires a guaranteed 403.
  const { data: portfolio } = useGetPortfolio({
    query: { enabled: canReadPortfolio, queryKey: getGetPortfolioQueryKey() },
  });
  // Operators pick (or provision) the firm an invitation targets.
  const { data: firms } = useListFirms({
    query: { enabled: isOperator, queryKey: getListFirmsQueryKey() },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const createFirm = useCreateFirm();
  const createReset = useCreatePasswordReset();

  const [email, setEmail] = useState("");
  const [prefill] = useState(() =>
    readInvitationPrefill(window.location.search),
  );
  const [role, setRole] = useState<CreateInvitationInputRole>(prefill.role);
  const [clientPartyId, setClientPartyId] = useState(prefill.clientPartyId);
  const [firmId, setFirmId] = useState("");
  const [newFirmName, setNewFirmName] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [issuedReset, setIssuedReset] = useState<{
    email: string;
    link: string;
  } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetCopied, setResetCopied] = useState(false);
  const [created, setCreated] = useState<InvitationWithToken | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // True once the admin has used the Copy button for THIS link — dismissing
  // an uncopied one-time link needs an explicit acknowledgement instead.
  const [linkCopied, setLinkCopied] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Confirm-before-revoke (and the revoke-then-prefill "New link" path).
  const [revokeTarget, setRevokeTarget] = useState<{
    invitation: Invitation;
    replace: boolean;
  } | null>(null);

  const clients = portfolio?.clients ?? [];
  // Operators see invitations across every firm, so the list needs a firm
  // column to be readable; firm admins only ever see their own and don't.
  const firmNameById = new Map((firms ?? []).map((f) => [f.id, f.name]));
  // Client invites are scoped to a party — resolve its display name from the
  // portfolio already fetched for the picker (operators, who cannot read a
  // firm's portfolio, fall back to the short UUID like the Firm column).
  const clientNameById = new Map(
    clients.map((c) => [c.clientPartyId, c.legalName]),
  );
  const hasClientList = clients.length > 0;
  const isClientRole = role === "client_user";
  // Operators bootstrap firm logins (first admin, then staff); client
  // invitations stay with the firm admin, whose engaged-client picker is
  // firm-scoped.
  const roleOptions = isOperator
    ? ROLE_OPTIONS.filter((r) => r !== "client_user")
    : ROLE_OPTIONS;

  // getListInvitationsQueryKey() has no params, so this invalidates the one
  // list query after any create/revoke.
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() });

  const onRoleChange = (value: string) => {
    setRole(value as CreateInvitationInputRole);
    // A client party only belongs on a client invite — drop it when leaving.
    if (value !== "client_user") setClientPartyId("");
    setFormError(null);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    if (!EMAIL_PATTERN.test(email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }
    if (isClientRole && !clientPartyId.trim()) {
      setFormError("Choose the client this login is scoped to.");
      return;
    }
    if (isOperator && !firmId) {
      setFormError("Choose the firm this invitation targets.");
      return;
    }
    const data: CreateInvitationInput = {
      email: email.trim(),
      role,
      // Operators name the target firm; firm principals invite into their own.
      ...(isOperator ? { firmId } : {}),
      // Only a client invitation may name a client party (server-enforced).
      ...(isClientRole ? { clientPartyId: clientPartyId.trim() } : {}),
    };
    try {
      const result = await create.mutateAsync({ data });
      setCreated(result);
      setCopied(false);
      setLinkCopied(false);
      setEmail("");
      setClientPartyId("");
      invalidate();
      toast({
        title: `Invitation created for ${result.invitation.email}`,
        description: "Copy the one-time accept link below — it is shown once.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Please try again.";
      setFormError(message);
      toast({
        title: "Could not create invitation",
        description: message,
        variant: "destructive",
      });
    }
  };

  const runRevoke = (invitation: Invitation, replace: boolean) => {
    setRevokingId(invitation.id);
    revoke.mutate(
      { id: invitation.id },
      {
        onSuccess: () => {
          // Clear the one-time token card if it was for this invite.
          setCreated((c) => (c?.invitation.id === invitation.id ? null : c));
          invalidate();
          if (replace) {
            // Prefill the form so the admin only has to press "Create
            // invite link" — the fresh token replaces the dead one.
            setEmail(invitation.email);
            setRole(invitation.role);
            setClientPartyId(invitation.clientPartyId ?? "");
            if (isOperator) setFirmId(invitation.firmId);
            setFormError(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
            toast({
              title: `Invitation to ${invitation.email} revoked`,
              description:
                "The form above is prefilled — create the new link when ready.",
            });
          } else {
            toast({ title: `Invitation to ${invitation.email} revoked` });
          }
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not revoke invitation",
            fallback: "Try again.",
          }),
        onSettled: () => setRevokingId(null),
      },
    );
  };

  const acceptLink = created
    ? acceptInviteLink(window.location.origin, created.token)
    : "";

  // Provision a new firm inline (operator identity.write), then pre-select it
  // so the next step is simply inviting its first firm_admin.
  const provisionFirm = async () => {
    const name = newFirmName.trim();
    if (!name) {
      setFormError("Enter a name for the new firm.");
      return;
    }
    setFormError(null);
    try {
      const firm = await createFirm.mutateAsync({ data: { name } });
      queryClient.invalidateQueries({ queryKey: getListFirmsQueryKey() });
      setFirmId(firm.id);
      setNewFirmName("");
      toast({
        title: `Firm "${firm.name}" provisioned`,
        description: "Now invite its first firm admin below.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Please try again.";
      setFormError(message);
      toast({
        title: "Could not provision the firm",
        description: message,
        variant: "destructive",
      });
    }
  };

  // Operator support path (IDN-02): issue a one-time password-reset link for
  // a user who lost access. The token is shown once, like an invite.
  const issueReset = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setResetError(null);
    if (!EMAIL_PATTERN.test(resetEmail.trim())) {
      setResetError("Enter a valid email address.");
      return;
    }
    try {
      const result = await createReset.mutateAsync({
        data: { email: resetEmail.trim() },
      });
      setIssuedReset({
        email: result.reset.email,
        link: resetPasswordLink(window.location.origin, result.token),
      });
      setResetCopied(false);
      setResetEmail("");
      toast({
        title: `Reset link issued for ${result.reset.email}`,
        description: "Copy the one-time link below — it is shown once.",
      });
    } catch (err) {
      const message =
        errorStatus(err) === 404
          ? "No account with that email."
          : err instanceof Error
            ? err.message
            : "Please try again.";
      setResetError(message);
      toast({
        title: "Could not issue the reset link",
        description: message,
        variant: "destructive",
      });
    }
  };

  const copyResetLink = async () => {
    if (!issuedReset) return;
    try {
      await navigator.clipboard.writeText(issuedReset.link);
      setResetCopied(true);
      toast({ title: "Reset link copied" });
      window.setTimeout(() => setResetCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the link and copy it manually.",
        variant: "destructive",
      });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(acceptLink);
      setCopied(true);
      setLinkCopied(true);
      toast({ title: "Accept link copied" });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the link and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return {
    me,
    canReadPortfolio,
    isOperator,
    invitations,
    isLoading,
    error,
    refetch,
    portfolio,
    firms,
    queryClient,
    toast,
    create,
    revoke,
    createFirm,
    createReset,
    email,
    setEmail,
    prefill,
    role,
    setRole,
    clientPartyId,
    setClientPartyId,
    firmId,
    setFirmId,
    newFirmName,
    setNewFirmName,
    resetEmail,
    setResetEmail,
    issuedReset,
    setIssuedReset,
    resetError,
    setResetError,
    resetCopied,
    setResetCopied,
    created,
    setCreated,
    formError,
    setFormError,
    copied,
    setCopied,
    linkCopied,
    setLinkCopied,
    confirmDismiss,
    setConfirmDismiss,
    revokingId,
    setRevokingId,
    revokeTarget,
    setRevokeTarget,
    clients,
    firmNameById,
    clientNameById,
    hasClientList,
    isClientRole,
    roleOptions,
    invalidate,
    onRoleChange,
    submit,
    runRevoke,
    acceptLink,
    provisionFirm,
    issueReset,
    copyResetLink,
    copyLink,
  };
}

export type InvitationsState = ReturnType<typeof useInvitations>;
