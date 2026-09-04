export type UsabilityEvent =
  | "landing_cta"
  | "login_attempt"
  | "login_success"
  | "login_failure"
  | "password_reset_request"
  | "calculator_started"
  | "calculator_completed"
  | "advisory_request"
  | "zero_result_search"
  | "workflow_started"
  | "workflow_completed"
  | "workflow_abandoned"
  | "help_opened"
  | "help_search_no_result"
  | "help_helpful"
  | "help_unhelpful"
  | "access_request_started"
  | "access_request_submitted"
  | "access_request_failed"
  | "today_item_opened"
  | "work_item_created"
  | "work_item_completed"
  | "collaboration_comment_added"
  | "global_search_started"
  | "global_search_result_opened"
  | "integration_tested"
  | "offline_detected"
  | "online_restored"
  | "sessions_revoked";

export type UsabilitySurface =
  | "landing"
  | "login"
  | "password_reset"
  | "calculator"
  | "portfolio"
  | "client_import"
  | "invoice_import"
  | "console_help"
  | "sme_help"
  | "access_request"
  | "today"
  | "global_search"
  | "collaboration"
  | "integrations"
  | "account_security"
  | "app_shell";

// Fire-and-forget, aggregate-only telemetry. The closed payload contains no
// user, tenant, field value, free text, URL, or identifier. Failures never
// interrupt the user's action.
export function trackUsabilityEvent(
  event: UsabilityEvent,
  surface: UsabilitySurface,
): void {
  if (typeof window === "undefined") return;
  void fetch("/api/public/usability-events", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      "x-meridian-csrf": "1",
    },
    body: JSON.stringify({ event, surface }),
  }).catch(() => undefined);
}
