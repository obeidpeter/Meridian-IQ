import { useEffect, useState } from "react";
import {
  useGetMe,
  useGetAlertPreferences,
  useUpdateAlertPreferences,
  useSendTestAlert,
  getGetAlertPreferencesQueryKey,
  type AlertPreferencesInput,
  type AlertDeliveryResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Phone, Mail, Send } from "lucide-react";
import { humanize } from "@/lib/format";

function AlertsSkeleton() {
  return (
    <div className="space-y-6">
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function Alerts() {
  usePageTitle("Alert settings");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: prefs,
    isLoading,
    isError,
    refetch,
  } = useGetAlertPreferences(clientPartyId, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetAlertPreferencesQueryKey(clientPartyId),
    },
  });
  const update = useUpdateAlertPreferences();
  const test = useSendTestAlert();

  const [form, setForm] = useState<AlertPreferencesInput>({});
  const [results, setResults] = useState<AlertDeliveryResult[] | null>(null);

  useEffect(() => {
    if (prefs) {
      setForm({
        whatsappEnabled: prefs.whatsappEnabled,
        smsEnabled: prefs.smsEnabled,
        emailEnabled: prefs.emailEnabled,
        whatsappTo: prefs.whatsappTo,
        phone: prefs.phone,
        email: prefs.email,
        deadlineAlerts: prefs.deadlineAlerts,
        failureAlerts: prefs.failureAlerts,
        penaltyAlerts: prefs.penaltyAlerts,
      });
    }
  }, [prefs]);

  const set = <K extends keyof AlertPreferencesInput>(
    key: K,
    value: AlertPreferencesInput[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    try {
      await update.mutateAsync({ id: clientPartyId, data: form });
      // Not awaited: a background refetch rejection must not surface as a false
      // save error after the preferences already persisted.
      queryClient.invalidateQueries({
        queryKey: getGetAlertPreferencesQueryKey(clientPartyId),
      });
      toast({ title: "Alert settings saved", description: "Alert settings updated." });
    } catch (e) {
      toast({
        title: "Couldn't save alert preferences",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const sendTest = async () => {
    try {
      const res = await test.mutateAsync({ id: clientPartyId });
      setResults(res);
      toast({
        title: "Test alert sent",
        description: `Delivered across ${res.length} channel(s).`,
      });
    } catch (e) {
      toast({
        title: "Couldn't send test alert",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const channels: {
    key: "whatsapp" | "sms" | "email";
    enabledKey: keyof AlertPreferencesInput;
    contactKey: keyof AlertPreferencesInput;
    label: string;
    icon: typeof MessageSquare;
    placeholder: string;
  }[] = [
    { key: "whatsapp", enabledKey: "whatsappEnabled", contactKey: "whatsappTo", label: "WhatsApp", icon: MessageSquare, placeholder: "+234 800 000 0000" },
    { key: "sms", enabledKey: "smsEnabled", contactKey: "phone", label: "SMS", icon: Phone, placeholder: "+234 800 000 0000" },
    { key: "email", enabledKey: "emailEnabled", contactKey: "email", label: "Email", icon: Mail, placeholder: "you@business.com" },
  ];

  const alertTypes: { key: keyof AlertPreferencesInput; label: string; desc: string }[] = [
    { key: "deadlineAlerts", label: "Deadline reminders", desc: "Upcoming VAT and filing deadlines." },
    { key: "failureAlerts", label: "Submission failures", desc: "When an invoice is rejected by the rail." },
    { key: "penaltyAlerts", label: "Penalty watch", desc: "When an invoice is overdue for stamping." },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Alert preferences
          </h1>
          <p className="text-muted-foreground mt-1">
            Choose how and where you want to be reminded.
          </p>
        </div>
      </div>

      <RequireClientScope thing="alert preferences">
        {isLoading ? (
          <AlertsSkeleton />
        ) : isError ? (
          <QueryError thing="your alert preferences" onRetry={() => refetch()} />
        ) : (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Channels</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {channels.map((ch) => {
                  const Icon = ch.icon;
                  const enabled = Boolean(form[ch.enabledKey]);
                  const switchId = `switch-${ch.key}`;
                  const inputId = `input-${ch.key}`;
                  return (
                    <div key={ch.key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={switchId} className="flex items-center gap-2">
                          <Icon className="w-4 h-4" aria-hidden="true" /> {ch.label}
                        </Label>
                        <Switch
                          id={switchId}
                          checked={enabled}
                          onCheckedChange={(v) => set(ch.enabledKey, v as never)}
                        />
                      </div>
                      {enabled && (
                        <div>
                          <Label htmlFor={inputId} className="sr-only">
                            {ch.label} destination
                          </Label>
                          <Input
                            id={inputId}
                            placeholder={ch.placeholder}
                            value={(form[ch.contactKey] as string) || ""}
                            onChange={(e) => set(ch.contactKey, e.target.value as never)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>What to alert me about</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {alertTypes.map((a) => (
                  <div key={a.key} className="flex items-center justify-between gap-4">
                    <div>
                      <Label htmlFor={`switch-${a.key}`} className="font-medium">
                        {a.label}
                      </Label>
                      <p className="text-sm text-muted-foreground">{a.desc}</p>
                    </div>
                    <Switch
                      id={`switch-${a.key}`}
                      checked={Boolean(form[a.key])}
                      onCheckedChange={(v) => set(a.key, v as never)}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="flex flex-wrap gap-3">
              <Button onClick={save} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save preferences"}
              </Button>
              <Button
                variant="outline"
                onClick={sendTest}
                disabled={test.isPending}
              >
                <Send className="w-4 h-4 mr-2" aria-hidden="true" />
                {test.isPending ? "Sending…" : "Send test alert"}
              </Button>
            </div>

            {results && (
              <Card>
                <CardHeader>
                  <CardTitle>Test delivery results</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {results.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No channels enabled — turn one on and save first.
                    </p>
                  ) : (
                    results.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-sm border rounded-md px-3 py-2"
                      >
                        <span className="font-medium">{humanize(r.channel)}</span>
                        <span
                          className={
                            r.status === "failed"
                              ? "text-destructive"
                              : "text-emerald-700 dark:text-emerald-400"
                          }
                        >
                          {r.detail || humanize(r.status)}
                        </span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </RequireClientScope>
    </div>
  );
}
