// Clerk assurance — the guardrail status rules (R126, split from
// assurance.ts as the leaf both the signal derivation and the guardrail
// builder read). Pure functions, no DB.

export type GuardrailStatus = "healthy" | "watch" | "critical";

export function number(value: unknown): number {
  return Number(value ?? 0);
}

export function rate(part: number, whole: number): number {
  return whole > 0 ? Number((part / whole).toFixed(4)) : 0;
}

export function qualityStatus(
  value: number | null,
  healthyAt: number,
  criticalBelow: number,
): GuardrailStatus {
  if (value === null) return "watch";
  if (value >= healthyAt) return "healthy";
  if (value < criticalBelow) return "critical";
  return "watch";
}

export function failureRateStatus(
  value: number,
  sampleCount: number,
): GuardrailStatus {
  if (sampleCount === 0) return "watch";
  if (value <= 0.02) return "healthy";
  if (value >= 0.05) return "critical";
  return "watch";
}
