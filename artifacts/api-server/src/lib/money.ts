const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export function decimalToMinorUnits(value: string): bigint {
  if (!MONEY_RE.test(value)) {
    throw new Error("Invalid money value");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function isPositiveMoney(value: string): boolean {
  try {
    return decimalToMinorUnits(value) > 0n;
  } catch {
    return false;
  }
}
