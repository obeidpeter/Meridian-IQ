import type { Firm } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Globe } from "lucide-react";
import { SegmentedControl } from "@workspace/web-ui";
import type { PreviewMode } from "./theme";
import type { BrandStudioState } from "./use-brand-studio";

// The client workspace preview in desktop and mobile framing. The inline
// styles are what the accessibility suite reads back, so they ride on the
// hook's previewStyle / previewHighlight objects untouched.
export function WorkspacePreviewCard({
  state,
  firm,
}: {
  state: BrandStudioState;
  firm: Firm;
}) {
  const {
    previewMode,
    setPreviewMode,
    previewStyle,
    previewHighlight,
    initials,
    brandName,
    previewColor,
  } = state;
  return (
    <Card data-testid="card-preview">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Client workspace preview</CardTitle>
        <SegmentedControl<PreviewMode>
          items={[
            { value: "desktop", label: "Desktop" },
            { value: "mobile", label: "Mobile" },
          ]}
          value={previewMode}
          onChange={setPreviewMode}
          label="Preview viewport"
        />
      </CardHeader>
      <CardContent>
        <div className="grid min-h-[34rem] place-items-center overflow-hidden rounded-md border bg-slate-100 p-4">
          <div
            className={`overflow-hidden border border-slate-200 bg-white shadow-sm transition-[width] ${
              previewMode === "mobile"
                ? "h-[31rem] w-[18rem] rounded-[1.25rem]"
                : "h-[31rem] w-full rounded-md"
            }`}
          >
            {previewMode === "mobile" ? (
              <div
                className="flex h-14 items-center justify-between px-3"
                style={previewStyle}
                data-testid="preview-header"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="grid size-8 place-items-center rounded-md text-xs font-extrabold"
                    style={previewHighlight}
                  >
                    {initials}
                  </span>
                  <span className="max-w-36 truncate text-sm font-bold">
                    {brandName || firm.name}
                  </span>
                </span>
                <span className="text-lg" aria-hidden="true">
                  •••
                </span>
              </div>
            ) : null}
            <div
              className={
                previewMode === "desktop"
                  ? "grid h-full grid-cols-[7rem_minmax(0,1fr)]"
                  : "h-[calc(100%-3.5rem)]"
              }
            >
              {previewMode === "desktop" && (
                <div
                  className="flex flex-col p-3"
                  style={previewStyle}
                  data-testid="preview-header"
                >
                  <span
                    className="grid size-9 place-items-center rounded-md text-xs font-extrabold"
                    style={previewHighlight}
                  >
                    {initials}
                  </span>
                  <span className="mt-2 truncate text-xs font-bold">
                    {brandName || firm.name}
                  </span>
                  <div className="mt-8 space-y-2 text-[10px] font-semibold">
                    <p className="rounded px-2 py-1.5" style={previewHighlight}>
                      Dashboard
                    </p>
                    <p className="px-2 py-1.5">Invoices</p>
                    <p className="px-2 py-1.5">Filings</p>
                    <p className="px-2 py-1.5">Collections</p>
                  </div>
                </div>
              )}
              <div className="min-w-0 bg-[#f7f9f8] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase text-slate-500">
                      Today
                    </p>
                    <p className="mt-1 text-sm font-extrabold text-slate-950">
                      Business overview
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded-md px-2.5 py-1.5 text-[10px] font-bold"
                    style={previewStyle}
                    data-testid="preview-button"
                  >
                    New invoice
                  </button>
                </div>
                <div className="mt-5 grid grid-cols-2 border-y border-slate-200 bg-white">
                  {[
                    ["Submitted", "24"],
                    ["Outstanding", "₦2.4m"],
                    ["Due soon", "3"],
                    ["Risk", "Low"],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="border-b border-r border-slate-100 p-3"
                    >
                      <p className="text-[9px] font-semibold text-slate-500">
                        {label}
                      </p>
                      <p className="mt-1 text-sm font-extrabold text-slate-950">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-5">
                  <p className="text-xs font-bold text-slate-900">
                    Priority work
                  </p>
                  <div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 bg-white">
                    {[
                      "Review two draft invoices",
                      "Prepare the VAT return",
                      "Chase one overdue balance",
                    ].map((item, index) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 px-3 py-3"
                      >
                        <span
                          className="size-1.5 rounded-full"
                          style={{ backgroundColor: previewColor }}
                        />
                        <span className="text-[10px] font-medium text-slate-700">
                          {item}
                        </span>
                        <span className="ml-auto text-[9px] text-slate-400">
                          {index + 1}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PublicUrlCard({ subdomain }: { subdomain: string }) {
  return (
    <Card data-testid="card-public-url">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <Globe
            className="w-5 h-5 text-primary mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="font-medium">Public URL</p>
            <p
              className="text-sm font-mono mt-1 break-all"
              data-testid="text-public-url"
            >
              https://{subdomain || "your-firm"}.valo.example
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              The public shell resolves your branding before login via{" "}
              <span className="font-mono">
                /api/public/theme?subdomain={subdomain || "your-firm"}
              </span>
              .
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
