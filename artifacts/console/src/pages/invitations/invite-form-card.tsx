import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { roleLabel } from "@/components/capability-gate";
import { UserPlus, Building2 } from "lucide-react";
import type { InvitationsState } from "./use-invitations";

// The create-access-link form: the operator's target-firm section, email
// and role, the client picker for client_user invites, and the submit.
export function InviteFormCard({ state }: { state: InvitationsState }) {
  const {
    isOperator,
    firms,
    firmId,
    setFirmId,
    newFirmName,
    setNewFirmName,
    createFirm,
    provisionFirm,
    email,
    setEmail,
    role,
    onRoleChange,
    roleOptions,
    isClientRole,
    hasClientList,
    clientPartyId,
    setClientPartyId,
    clients,
    formError,
    setFormError,
    create,
    submit,
  } = state;
  return (
    <Card data-testid="card-invite-form">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <UserPlus aria-hidden="true" />
          </span>
          Create access link
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {isOperator && (
            <div
              className="space-y-3 rounded-lg border p-3"
              data-testid="section-target-firm"
            >
              <p className="text-sm font-medium flex items-center gap-2">
                <Building2
                  className="w-4 h-4 text-primary"
                  aria-hidden="true"
                />
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
                <Label htmlFor="new-firm-name">Or create a new firm</Label>
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
                    {createFirm.isPending ? "Creating…" : "Create firm"}
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
                    aria-label="Client this business user can access"
                    data-testid="select-client"
                  >
                    <SelectValue placeholder="Choose the client this business user can access" />
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
                    placeholder="Client record ID (UUID)"
                    data-testid="input-client"
                  />
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="text-client-hint"
                  >
                    The client this business user can access.
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
              data-testid="button-create-invite"
            >
              <UserPlus className="w-4 h-4 mr-1" aria-hidden="true" />
              {create.isPending ? "Creating…" : "Create invite link"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Valo does not email the invite — you copy the one-time link and
              share it yourself.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
