import {
  useGetAskFeedbackReport,
  getGetAskFeedbackReportQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollRegion } from "@/components/scroll-region";
import { formatDateTime, formatPct } from "@/lib/format";
import {
  overrideRateClass,
  shapeExample,
  askFeedbackTotalsLine,
  type MetricsGuard,
} from "./format";
import { PromoteToIntentCorpus } from "./eval-cards";

// The Quality tab of the Clerk health page (R110: split out of the page):
// calibration, field corrections and shapes, supplier accuracy, the kept-rate
// trend, and the Ask feedback card with its own query.

export function QualityTab({ withMetrics }: { withMetrics: MetricsGuard }) {
  // Ask helpfulness mining (the refusal-mining sibling): pure SQL over the
  // feedback column, loaded eagerly like the tier report. Render-on-success
  // — on an older server the endpoint 404s and the card simply never
  // appears, same as the tier report's skew posture.
  const { data: askFeedback } = useGetAskFeedbackReport({
    query: {
      queryKey: getGetAskFeedbackReportQueryKey(),
      staleTime: 5 * 60_000,
      retry: false,
    },
  });

  return (
    <>
      {withMetrics((metrics) => (
        <>
          {metrics.calibration && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Confidence calibration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  For approved cases, how often operators KEPT the model's value
                  at each confidence band ({metrics.calibration.sampleFields}{" "}
                  compared fields). Well-calibrated extraction keeps the two
                  columns close; a band where kept-rate falls far below the
                  confidence says the review-flagging threshold is trusting
                  numbers it shouldn't.
                </p>
                <ScrollRegion label="Confidence calibration table">
                  <table
                    className="w-full text-sm"
                    data-testid="table-calibration"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">
                          Confidence band
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Fields
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Mean confidence
                        </th>
                        <th className="py-2 font-medium text-right">
                          Kept rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.calibration.buckets.map((b) => (
                        <tr
                          key={b.range}
                          data-testid={`row-calibration-${b.range}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{b.range}</code>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {b.fields}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {b.fields === 0
                              ? "—"
                              : `${Math.round(b.meanConfidence * 100)}%`}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${
                              b.fields > 0 &&
                              b.meanConfidence - b.keptRate > 0.15
                                ? "text-red-600 dark:text-red-400 font-medium"
                                : ""
                            }`}
                          >
                            {b.fields === 0
                              ? "—"
                              : `${Math.round(b.keptRate * 100)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Field corrections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                How often operators corrected each extracted field before
                approval — the extraction-quality signal (labeled outcomes).
              </p>
              {metrics.corrections.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-corrections-empty"
                >
                  No corrections yet — they appear once cases are approved.
                </p>
              ) : (
                <ScrollRegion label="Field corrections table">
                  <table
                    className="w-full text-sm"
                    data-testid="table-corrections"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Overridden
                        </th>
                        <th className="py-2 font-medium text-right">
                          Override rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.corrections.map((c) => (
                        <tr
                          key={c.field}
                          data-testid={`row-correction-${c.field}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.field}</code>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.total}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.overridden}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${overrideRateClass(c.overrideRate)}`}
                          >
                            {formatPct(c.overrideRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </CardContent>
          </Card>

          {metrics.correctionShapes && metrics.correctionShapes.length > 0 && (
            <Card data-testid="section-correction-shapes">
              <CardHeader>
                <CardTitle className="text-base">Common corrections</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Common mistakes corrected during review, with examples of the
                  changes operators made.
                </p>
                <ScrollRegion label="Correction shapes table">
                  <table
                    className="w-full text-sm"
                    data-testid="table-correction-shapes"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium">Shape</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Count
                        </th>
                        <th className="py-2 font-medium">Example</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.correctionShapes.map((s) => (
                        <tr
                          key={`${s.field}-${s.shape}`}
                          data-testid={`row-correction-shape-${s.field}-${s.shape}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{s.field}</code>
                          </td>
                          <td className="py-2 pr-3">
                            {s.shape.replace(/_/g, " ")}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.count}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {shapeExample(s.exampleExtracted, s.exampleFinal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              </CardContent>
            </Card>
          )}

          <Card data-testid="section-supplier-accuracy">
            <CardHeader>
              <CardTitle className="text-base">Supplier accuracy</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                How often operators corrected Clerk's suggestions, grouped by
                the supplier on the approved invoice. Use this to identify
                documents that may need clearer scans or more careful review.
              </p>
              {metrics.supplierAccuracy.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-supplier-accuracy-empty"
                >
                  No corrected approvals in this window yet.
                </p>
              ) : (
                <ScrollRegion label="Supplier accuracy table">
                  <table
                    className="w-full text-sm"
                    data-testid="table-supplier-accuracy"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Supplier</th>
                        <th className="py-2 pr-3 font-medium">Firm</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Cases
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Fields
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Overridden
                        </th>
                        <th className="py-2 font-medium text-right">
                          Override rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.supplierAccuracy.map((s, i) => (
                        <tr key={i} data-testid={`row-supplier-accuracy-${i}`}>
                          <td className="py-2 pr-3">{s.supplierName}</td>
                          <td className="py-2 pr-3 text-muted-foreground">
                            {s.firmName ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.cases}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.fieldsCompared}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.overridden}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${overrideRateClass(s.overrideRate)}`}
                          >
                            {formatPct(s.overrideRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </CardContent>
          </Card>

          {(metrics.keptRateTrend?.length ?? 0) > 0 && (
            <Card data-testid="section-kept-rate-trend">
              <CardHeader>
                <CardTitle className="text-base">
                  Suggested values kept unchanged
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  The share of compared values that operators kept unchanged
                  when approving, by month. Calculated from saved review
                  records, not judged by an AI model.
                </p>
                <ScrollRegion label="Kept-rate by month table">
                  <table
                    className="w-full text-sm"
                    data-testid="table-kept-rate-months"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Month</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Fields
                        </th>
                        <th className="py-2 font-medium text-right">
                          Kept rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(metrics.keptRateTrend ?? []).map((m) => (
                        <tr key={m.month}>
                          <td className="py-2 pr-3 tabular-nums">{m.month}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {m.fields}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {m.fields === 0 ? "—" : formatPct(m.keptRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              </CardContent>
            </Card>
          )}
        </>
      ))}

      {/* Independent of /clerk/metrics on purpose: the feedback report
          is its own query, so a metrics failure doesn't hide it (and
          vice versa). */}
      {askFeedback && (
        <Card data-testid="card-ask-feedback">
          <CardHeader>
            <CardTitle className="text-base">Ask feedback</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Helpfulness signals askers left on answered questions — the
              refusal-mining sibling. Most askers rate nothing, so read the
              split against the unrated count.
            </p>
            <p className="text-sm" data-testid="text-ask-feedback-totals">
              {askFeedbackTotalsLine(askFeedback.totals)}
            </p>
            {askFeedback.byIntent.length > 0 && (
              <ScrollRegion label="Ask feedback by intent table">
                <table
                  className="w-full text-sm"
                  data-testid="table-ask-feedback-intents"
                >
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Intent</th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Helpful
                      </th>
                      <th className="py-2 font-medium text-right">
                        Not helpful
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {askFeedback.byIntent.map((r) => (
                      <tr
                        key={r.intent}
                        data-testid={`row-ask-feedback-${r.intent}`}
                      >
                        <td className="py-2 pr-3 font-mono text-xs">
                          {r.intent}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.helpful}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {r.notHelpful}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
            {askFeedback.recentNotHelpful.length > 0 && (
              <div data-testid="list-ask-feedback-not-helpful">
                <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                  Recent not-helpful questions
                </p>
                <ul className="space-y-1 text-sm">
                  {askFeedback.recentNotHelpful.map((q) => (
                    <li
                      key={q.caseId}
                      className="flex items-baseline gap-2"
                      data-testid={`row-not-helpful-${q.caseId}`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {q.question}
                      </span>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(q.createdAt)}
                      </span>
                      <PromoteToIntentCorpus caseId={q.caseId} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
