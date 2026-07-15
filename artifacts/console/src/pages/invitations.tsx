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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { roleLabel } from "@/components/capability-gate";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDateTime, pillClasses } from "@/lib/format";
import {
  acceptInviteLink,
  resetPasswordLink,
  invitationStatusTone,
  invitationStatusLabel,
} from "@/lib/invitations";
import {
  UserPlus,
  Building2,
  Copy,
  Check,
  Mail,
  KeyRound,
  AlertTriangle,
  X,
} from "lucide-react";

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

export function Invitations() {
  usePageTitle("Team invitations");
  const { data: me } = useGetMe();
  const canReadPortfolio = (me?.capabilities ?? []).includes(
    "console.portfolio.read",
  );
  // identity.write marks the operator: invitations then target a chosen firm
  // (the new-firm bootstrap path) instead of the caller's own.
  const isOperator = (me?.capabilities ?? []).includes("identity.write");

  const {
    data: invitations,
    isLoading,
    error,
    refetch,
  } = useListInvitations();
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
  const [role, setRole] = useState<CreateInvitationInputRole>("firm_staff");
  const [clientPartyId, setClientPartyId] = useState("");
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
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const clients = portfolio?.clients ?? [];
  // Operators see invitations across every firm, so the list needs a firm
  // column to be readable; firm admins only ever see their own and don't.
  const firmNameById = new Map((firms ?? []).map((f) => [f.id, f.name]));
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

  const runRevoke = (invitation: Invitation) => {
    setRevokingId(invitation.id);
    revoke.mutate(
      { id: invitation.id },
      {
        onSuccess: () => {
          toast({ title: `Invitation to ${invitation.email} revoked` });
          // Clear the one-time token card if it was for this invite.
          setCreated((c) =>
            c?.invitation.id === invitation.id ? null : c,
          );
          invalidate();
        },
        onError: () =>
          toast({
            title: "Could not revoke invitation",
            variant: "destructive",
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
      const status = (err as { status?: number })?.status;
      const message =
        status === 404
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

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Team invitations
        </h1>
        <p className="text-muted-foreground mt-1">
          {isOperator
            ? "Onboard a firm: provision it, then invite its first firm admin — every invite issues a one-time link to set a password and join. The admin self-serves teammates and clients from there."
            : "Invite a teammate or client into your firm. Each invite issues a one-time link to set a password and join — pending invites can be revoked before they are accepted."}
        </p>
      </div>

      <Card data-testid="card-invite-form">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" aria-hidden="true" />
            Invite someone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {isOperator && (
              <div className="space-y-3 rounded-lg border p-3" data-testid="section-target-firm">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-primary" aria-hidden="true" />
                  Target firm
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="invite-firm">Firm</Label>
                  <Select
                    value={firmId || undefined}
                    onValueChange={(v) => {
                      setFirmId(v);
                      setFormError(null);
                    }}
                  >
                    <SelectTrigger
                      id="invite-firm"
                      aria-label="Firm this invitation targets"
                      data-testid="select-firm"
                    >
                      <SelectValue placeholder="Pick the firm this invitation targets" />
                    </SelectTrigger>
                    <SelectContent>
                      {(firms ?? []).map((f) => (
                        <SelectItem
                          key={f.id}
                          value={f.id}
                          data-testid={`firm-option-${f.id}`}
                        >
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-firm-name">…or provision a new firm</Label>
                  <div className="flex gap-2">
                    <Input
                      id="new-firm-name"
                      value={newFirmName}
                      onChange={(e) => {
                        setNewFirmName(e.target.value);
                        setFormError(null);
                      }}
                      placeholder="Firm name"
                      data-testid="input-new-firm-name"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={provisionFirm}
                      disabled={createFirm.isPending}
                      data-testid="button-provision-firm"
                    >
                      {createFirm.isPending ? "Provisioning…" : "Provision firm"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Creates the firm and selects it, ready for its first
                    firm-admin invite.
                  </p>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  autoComplete="off"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setFormError(null);
                  }}
                  placeholder="teammate@firm.com"
                  data-testid="input-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={role} onValueChange={onRoleChange}>
                  <SelectTrigger
                    id="invite-role"
                    aria-label="Role"
                    data-testid="select-role"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((r) => (
                      <SelectItem
                        key={r}
                        value={r}
                        data-testid={`role-option-${r}`}
                      >
                        {roleLabel(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isClientRole && (
              <div className="space-y-1.5">
                <Label htmlFor="invite-client">Client</Label>
                {hasClientList ? (
                  <Select
                    value={clientPartyId}
                    onValueChange={(v) => {
                      setClientPartyId(v);
                      setFormError(null);
                    }}
                  >
                    <SelectTrigger
                      id="invite-client"
                      aria-label="Client this login is scoped to"
                      data-testid="select-client"
                    >
                      <SelectValue placeholder="Pick the client this login is scoped to" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((c) => (
                        <SelectItem
                          key={c.clientPartyId}
                          value={c.clientPartyId}
                          data-testid={`client-option-${c.clientPartyId}`}
                        >
                          {c.legalName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <>
                    <Input
                      id="invite-client"
                      value={clientPartyId}
                      onChange={(e) => {
                        setClientPartyId(e.target.value);
                        setFormError(null);
                      }}
                      placeholder="Client party UUID"
                      data-testid="input-client"
                    />
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-client-hint"
                    >
                      The client this login is scoped to.
                    </p>
                  </>
                )}
              </div>
            )}

            {formError && (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid="text-form-error"
              >
                {formError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={create.isPending}
                data-testid="button-send-invite"
              >
                <UserPlus className="w-4 h-4 mr-1" aria-hidden="true" />
                {create.isPending ? "Sending…" : "Send invitation"}
              </Button>
              <p className="text-xs text-muted-foreground">
                They get a one-time link to set a password and join your firm.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {isOperator && (
        <Card data-testid="card-password-reset">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" aria-hidden="true" />
              Issue a password reset link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Support path for a user who lost access: issues a one-time link
              (valid 24 hours) that sets a new password and signs out every
              existing session. Share it out-of-band, like an invite.
            </p>
            <form onSubmit={issueReset} className="flex gap-2" noValidate>
              <Input
                type="email"
                required
                autoComplete="off"
                value={resetEmail}
                onChange={(e) => {
                  setResetEmail(e.target.value);
                  setResetError(null);
                }}
                placeholder="user@firm.com"
                aria-label="Email of the account to reset"
                data-testid="input-reset-email"
              />
              <Button
                type="submit"
                variant="outline"
                className="shrink-0"
                disabled={createReset.isPending}
                data-testid="button-issue-reset"
              >
                {createReset.isPending ? "Issuing…" : "Issue link"}
              </Button>
            </form>
            {resetError && (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid="text-reset-error"
              >
                {resetError}
              </p>
            )}
            {issuedReset && (
              <div
                className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/40"
                role="status"
                aria-live="polite"
                data-testid="card-reset-token"
              >
                <p className="text-sm font-medium">
                  One-time reset link for {issuedReset.email}
                </p>
                <p className="text-xs text-muted-foreground">
                  Shown once — copy it now and share it with the user directly.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={issuedReset.link}
                    onFocus={(e) => e.target.select()}
                    className="font-mono text-xs"
                    aria-label="One-time reset link"
                    data-testid="input-reset-link"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    onClick={copyResetLink}
                    data-testid="button-copy-reset-link"
                  >
                    {resetCopied ? (
                      <Check className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <Copy className="w-4 h-4" aria-hidden="true" />
                    )}
                    {resetCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {created && (
        <Card
          className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40"
          data-testid="card-invite-token"
          role="status"
          aria-live="polite"
        >
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base text-amber-900 dark:text-amber-200">
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              Invitation for {created.invitation.email}
            </CardTitle>
            <button
              type="button"
              onClick={() => setCreated(null)}
              aria-label="Dismiss invitation link"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="button-dismiss-token"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
              <AlertTriangle
                className="w-4 h-4 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              This link is shown once — copy it now. The token cannot be
              retrieved again.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="invite-accept-link">Accept link</Label>
              <div className="flex gap-2">
                <Input
                  id="invite-accept-link"
                  readOnly
                  value={acceptLink}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                  data-testid="input-accept-link"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={copyLink}
                  data-testid="button-copy-link"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 mr-1" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1" aria-hidden="true" />
                      Copy link
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-token">One-time token</Label>
              <Input
                id="invite-token"
                readOnly
                value={created.token}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
                data-testid="text-token"
              />
            </div>

            <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
              Share it with {created.invitation.email}. They set a password at
              the link to join as {roleLabel(created.invitation.role)}. It
              expires {formatDateTime(created.invitation.expiresAt)}.
            </p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-invitations">
        <CardHeader>
          <CardTitle className="text-base">Invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3" data-testid="loading-invitations">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : error ? (
            <QueryError thing="invitations" onRetry={() => refetch()} />
          ) : (invitations ?? []).length === 0 ? (
            <div className="py-10 flex flex-col items-center text-center gap-2">
              <Mail
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-empty">
                No invitations yet
              </p>
              <p className="text-sm text-muted-foreground">
                Invite a teammate or client above — pending invitations appear
                here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                data-testid="table-invitations"
              >
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Email
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Role
                    </th>
                    {isOperator && (
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Firm
                      </th>
                    )}
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Created
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Expires
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(invitations ?? []).map((inv) => (
                    <tr key={inv.id} data-testid={`row-invitation-${inv.id}`}>
                      <td className="py-2.5 pr-3 font-medium">{inv.email}</td>
                      <td className="py-2.5 pr-3">{roleLabel(inv.role)}</td>
                      {isOperator && (
                        <td
                          className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap"
                          data-testid={`firm-${inv.id}`}
                        >
                          {firmNameById.get(inv.firmId) ?? (
                            <span className="font-mono text-xs">
                              {inv.firmId.slice(0, 8)}
                            </span>
                          )}
                        </td>
                      )}
                      <td className="py-2.5 pr-3">
                        <span
                          className={pillClasses(
                            invitationStatusTone(inv.status),
                          )}
                          data-testid={`status-${inv.id}`}
                        >
                          {invitationStatusLabel(inv.status)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(inv.createdAt)}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(inv.expiresAt)}
                      </td>
                      <td className="py-2.5 text-right">
                        {inv.status === "pending" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={revoke.isPending && revokingId === inv.id}
                            onClick={() => runRevoke(inv)}
                            data-testid={`button-revoke-${inv.id}`}
                          >
                            {revoke.isPending && revokingId === inv.id
                              ? "Revoking…"
                              : "Revoke"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
