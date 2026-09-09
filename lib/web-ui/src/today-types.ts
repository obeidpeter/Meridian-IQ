export interface TodaySetupStepView {
  id: string;
  label: string;
  description: string;
  complete: boolean;
  href: string;
  /** A server-proven restriction; never inferred from an omitted feature. */
  blockedReason?: string | null;
}
