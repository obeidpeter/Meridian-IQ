import { useState } from "react";
import {
  useListPipeline,
  useCreateProspect,
  useUpdateProspect,
  getListPipelineQueryKey,
  getGetUnearnedIncomeQueryKey,
} from "@workspace/api-client-react";
import type {
  OnboardingProspect,
  ProspectInputStage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";

const STAGES: { key: ProspectInputStage; label: string }[] = [
  { key: "lead", label: "Lead" },
  { key: "contacted", label: "Contacted" },
  { key: "proposal", label: "Proposal" },
  { key: "onboarding", label: "Onboarding" },
  { key: "active", label: "Active" },
  { key: "lost", label: "Lost" },
];

const STAGE_LABEL: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.label]),
);

export function Pipeline() {
  const { data, isLoading } = useListPipeline();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<ProspectInputStage>("lead");
  const [estimate, setEstimate] = useState("50");

  const createProspect = useCreateProspect();
  const updateProspect = useUpdateProspect();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPipelineQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetUnearnedIncomeQueryKey(),
    });
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    createProspect.mutate(
      {
        data: {
          name: name.trim(),
          contactEmail: email.trim() || undefined,
          stage,
          estimatedMonthlyInvoices: Number(estimate) || 0,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Prospect added" });
          setName("");
          setEmail("");
          setStage("lead");
          setEstimate("50");
          setOpen(false);
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not add prospect", variant: "destructive" }),
      },
    );
  };

  const advanceStage = (p: OnboardingProspect, newStage: ProspectInputStage) => {
    updateProspect.mutate(
      { id: p.id, data: { stage: newStage } },
      {
        onSuccess: () => invalidate(),
        onError: () =>
          toast({ title: "Could not update stage", variant: "destructive" }),
      },
    );
  };

  const byStage = (s: string) =>
    (data ?? []).filter((p) => p.stage === s);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Onboarding pipeline
          </h1>
          <p className="text-muted-foreground mt-1">
            Track prospects from lead to active client.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-prospect">
              <Plus className="w-4 h-4 mr-2" /> Add prospect
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New prospect</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="p-name">Name</Label>
                <Input
                  id="p-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-prospect-name"
                />
              </div>
              <div>
                <Label htmlFor="p-email">Contact email</Label>
                <Input
                  id="p-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-prospect-email"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Stage</Label>
                  <Select
                    value={stage}
                    onValueChange={(v) => setStage(v as ProspectInputStage)}
                  >
                    <SelectTrigger data-testid="select-prospect-stage">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAGES.map((s) => (
                        <SelectItem key={s.key} value={s.key}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="p-est">Est. monthly invoices</Label>
                  <Input
                    id="p-est"
                    type="number"
                    value={estimate}
                    onChange={(e) => setEstimate(e.target.value)}
                    data-testid="input-prospect-estimate"
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={createProspect.isPending || !name.trim()}
                data-testid="button-save-prospect"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STAGES.filter((s) => s.key !== "lost").map((s) => {
            const items = byStage(s.key);
            return (
              <Card key={s.key} data-testid={`column-${s.key}`}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center justify-between">
                    {s.label}
                    <span className="text-muted-foreground font-normal">
                      {items.length}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">—</p>
                  ) : (
                    items.map((p) => (
                      <div
                        key={p.id}
                        data-testid={`card-prospect-${p.id}`}
                        className="border rounded-md p-3 space-y-2"
                      >
                        <p className="font-medium text-sm">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          ~{p.estimatedMonthlyInvoices} inv/mo
                        </p>
                        <Select
                          value={p.stage}
                          onValueChange={(v) =>
                            advanceStage(p, v as ProspectInputStage)
                          }
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            data-testid={`select-stage-${p.id}`}
                          >
                            <SelectValue>{STAGE_LABEL[p.stage]}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {STAGES.map((st) => (
                              <SelectItem key={st.key} value={st.key}>
                                {st.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
