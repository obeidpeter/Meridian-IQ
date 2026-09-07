import { collectAccessibilityIssues } from "../accessibility.mjs";
import { apiLogin, apiLogout } from "./shared.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROUTE_GROUPS = [
  {
    identity: null,
    routes: [
      "/",
      "/login",
      "/reset-password",
      "/invoice-room",
      "/penalty-calculator/",
    ],
  },
  {
    identity: "owner@adaezefoods.example",
    routes: [
      "/app/",
      "/app/month-end",
      "/app/collections",
      "/app/analytics",
      "/app/notifications",
      "/app/activity",
      "/app/invoices",
      "/app/invoices/new",
      "/app/bills",
      "/app/vat",
      "/app/recurring",
      "/app/import",
      "/app/clerk",
      "/app/clerk/ask",
      "/app/reconciliation",
      "/app/b2c",
      "/app/obligations",
      "/app/filings",
      "/app/wht",
      "/app/calendar",
      "/app/alerts",
      "/app/consent",
      "/app/help",
    ],
  },
  {
    identity: "demo.admin@valo.example",
    routes: [
      "/console/",
      "/console/notifications",
      "/console/activity",
      "/console/help",
      "/console/filing-desk",
      "/console/collections",
      "/console/analytics",
      "/console/clients/import",
      "/console/pipeline",
      "/console/unearned-income",
      "/console/billing",
      "/console/whitelabel",
      "/console/certification",
      "/console/advisory",
      "/console/invitations",
      "/console/access-review",
      "/console/integrations",
      "/console/api-access",
      "/console/data-room",
      "/console/statements",
      "/console/clerk/claims",
    ],
  },
  {
    identity: "ops@valo.example",
    routes: [
      "/console/operator-queue",
      "/console/parties",
      "/console/catalogue",
      "/console/platform-ops",
      "/console/control-centre/activation",
      "/console/control-centre/buyers",
      "/console/control-centre/cases",
      "/console/control-centre/reliability",
      "/console/control-centre/evidence",
      "/console/control-centre/clerk",
      "/console/feature-flags",
      "/console/clerk",
      "/console/clerk/ask",
      "/console/clerk/health",
    ],
  },
  { identity: "audit@valo.example", routes: ["/console/audit"] },
  {
    identity: "finance@zenithretail.example",
    routes: [
      "/buyer/",
      "/buyer/suppliers",
      "/buyer/scoreboard",
      "/buyer/notifications",
    ],
  },
];

const VIEWPORTS = [
  ["reflow", { width: 320, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1360, height: 900 }],
];

export async function journeyAccessibilityMatrix(page, BASE, check) {
  for (const group of ROUTE_GROUPS) {
    if (group.identity) await apiLogin(page, BASE, group.identity);
    else await apiLogout(page, BASE);

    for (const route of group.routes) {
      for (const [viewportName, viewport] of VIEWPORTS) {
        try {
          await page.setViewportSize(viewport);
          await page.goto(BASE + route, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          await page
            .waitForLoadState("networkidle", { timeout: 5_000 })
            .catch(() => {});
          await page.waitForSelector("h1", { timeout: 8_000 }).catch(() => {});
          await page.waitForTimeout(300);
          const issues = await collectAccessibilityIssues(page, {
            reportAxe: (results) => {
              const dir = path.resolve("test-results/accessibility");
              mkdirSync(dir, { recursive: true });
              const name = `${route.replace(/[^a-z0-9]/gi, "_")}-${viewportName}`;
              writeFileSync(
                path.join(dir, `${name}.json`),
                JSON.stringify(results, null, 2),
              );
            },
          });
          check(
            `accessibility matrix: ${route} (${viewportName})`,
            issues.length === 0,
            issues.slice(0, 8).join("; "),
          );
        } catch (error) {
          check(
            `accessibility matrix: ${route} (${viewportName})`,
            false,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }
}
