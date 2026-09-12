export type SetupStep = {
  id: string;
  label: string;
  description: string;
  complete: boolean;
  href: string;
  blockedReason?: string | null;
};
