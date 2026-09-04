// Shared line-financials accumulation for draft creation and content updates
// (the invariant-bearing totals math lived copy-pasted in both). Totals are
// accumulated from the ROUNDED per-line strings (lineExtension / vatAmount) in
// left-to-right order — never recomputed from raw qty*price, which would
// differ by cents on edge inputs. Callers keep money() at the write sites so
// persisted string formatting is unchanged.
import {
  computeLineFinancials,
  FinancialDecimal,
  money,
  type LineInput,
} from "./lines";

export type ComputedLine = LineInput &
  ReturnType<typeof computeLineFinancials> & { lineNo: number };

export function computeLinesWithTotals(lines: LineInput[]): {
  computed: ComputedLine[];
  subtotal: string;
  vatTotal: string;
  grandTotal: string;
} {
  let subtotal = new FinancialDecimal(0);
  let vatTotal = new FinancialDecimal(0);
  const computed = lines.map((l, idx) => {
    const fin = computeLineFinancials(l);
    subtotal = subtotal.plus(fin.lineExtension);
    vatTotal = vatTotal.plus(fin.vatAmount);
    return { ...l, ...fin, lineNo: idx + 1 };
  });
  return {
    computed,
    subtotal: money(subtotal),
    vatTotal: money(vatTotal),
    grandTotal: money(subtotal.plus(vatTotal)),
  };
}
