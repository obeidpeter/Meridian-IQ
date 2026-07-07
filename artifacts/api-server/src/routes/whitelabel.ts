import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, firmsTable, partiesTable, engagementsTable } from "@workspace/db";
import {
  GetPublicThemeQueryParams,
  GetPublicThemeResponse,
  UpdateFirmThemeParams,
  UpdateFirmThemeBody,
  UpdateFirmThemeResponse,
  ImportClientsBody,
  ImportClientsResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertSameTenant,
  tenantFirmId,
} from "../modules/auth/rbac";
import { isFeatureEnabled } from "../modules/flags/flags";
import { appendAudit } from "../modules/audit/audit";
import { validateTin, validateCac } from "../modules/party/party";

// White-label at scale (CON-05): firm theming resolved by subdomain from one
// deployment (no per-firm builds), and bulk client import from
// practice-management exports. Gated by the R2 `white_label` flag.

const router: IRouter = Router();

// Public branding resolution: the app shell needs the theme before any login,
// so this endpoint is on the PUBLIC_PATHS allowlist and returns branding only —
// never tenant data.
router.get("/public/theme", async (req, res): Promise<void> => {
  if (!(await isFeatureEnabled("white_label", null))) {
    res.sendStatus(404);
    return;
  }
  const query = GetPublicThemeQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const [firm] = await getDb()
    .select({
      firmId: firmsTable.id,
      name: firmsTable.name,
      subdomain: firmsTable.subdomain,
      theme: firmsTable.theme,
    })
    .from(firmsTable)
    .where(eq(firmsTable.subdomain, query.data.subdomain))
    .limit(1);
  if (!firm) {
    res.status(404).json({ error: "No firm on this subdomain" });
    return;
  }
  res.json(GetPublicThemeResponse.parse(firm));
});

router.put("/firms/:id/theme", async (req, res): Promise<void> => {
  if (!(await isFeatureEnabled("white_label", req.principal.firmId))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "theme.write");
  const params = UpdateFirmThemeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateFirmThemeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  assertSameTenant(req.principal, params.data.id);
  const [existing] = await getDb()
    .select({ id: firmsTable.id, theme: firmsTable.theme, subdomain: firmsTable.subdomain })
    .from(firmsTable)
    .where(eq(firmsTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  const [row] = await getDb()
    .update(firmsTable)
    .set({
      theme: body.data.theme as Record<string, unknown>,
      ...(body.data.subdomain ? { subdomain: body.data.subdomain } : {}),
    })
    .where(eq(firmsTable.id, params.data.id))
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: params.data.id,
    action: "firm.theme_update",
    entityType: "firm",
    entityId: params.data.id,
    before: { theme: existing.theme, subdomain: existing.subdomain },
    after: { theme: row.theme, subdomain: row.subdomain },
  });
  res.json(UpdateFirmThemeResponse.parse(row));
});

// Bulk client import (CON-05): rows from a practice-management export become
// client parties plus engagements (the engagement is what places the client in
// the firm's tenant boundary — see assertPartyAccess). Validate-then-commit
// with per-row results, mirroring the invoice-import contract.
router.post("/clients/import", async (req, res): Promise<void> => {
  if (!(await isFeatureEnabled("white_label", req.principal.firmId))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "clients.import");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = ImportClientsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  type RowResult = {
    rowNumber: number;
    status: "created" | "exists" | "invalid";
    partyId: string | null;
    engagementId: string | null;
    errors: { field: string; message: string }[];
  };
  const results: RowResult[] = [];

  for (let i = 0; i < parsed.data.rows.length; i++) {
    const row = parsed.data.rows[i];
    const rowNumber = i + 1;
    const errors: { field: string; message: string }[] = [];
    let tin: string | null = null;
    let tinValidated = false;
    if (row.tin) {
      const check = validateTin(row.tin);
      if (!check.valid) {
        errors.push({ field: "tin", message: "TIN failed format validation" });
      } else {
        tin = check.normalized;
        tinValidated = true;
      }
    }
    let cac: string | null = null;
    if (row.cacNumber) {
      const check = validateCac(row.cacNumber);
      if (!check.valid) {
        errors.push({ field: "cacNumber", message: "CAC number failed format validation" });
      } else {
        cac = check.normalized;
      }
    }
    if (errors.length > 0) {
      results.push({ rowNumber, status: "invalid", partyId: null, engagementId: null, errors });
      continue;
    }

    // Existing client detection: by validated TIN first, then by exact legal
    // name among this firm's engaged clients.
    let existingPartyId: string | null = null;
    if (tin) {
      const [byTin] = await getDb()
        .select({ id: partiesTable.id })
        .from(partiesTable)
        .where(eq(partiesTable.tin, tin))
        .limit(1);
      existingPartyId = byTin?.id ?? null;
    }
    if (!existingPartyId) {
      const [byName] = await getDb()
        .select({ id: partiesTable.id })
        .from(partiesTable)
        .innerJoin(
          engagementsTable,
          and(
            eq(engagementsTable.clientPartyId, partiesTable.id),
            eq(engagementsTable.firmId, firmId),
          ),
        )
        .where(eq(partiesTable.legalName, row.legalName))
        .limit(1);
      existingPartyId = byName?.id ?? null;
    }
    if (existingPartyId) {
      results.push({
        rowNumber,
        status: "exists",
        partyId: existingPartyId,
        engagementId: null,
        errors: [],
      });
      continue;
    }
    if (!parsed.data.commit) {
      results.push({ rowNumber, status: "created", partyId: null, engagementId: null, errors: [] });
      continue;
    }

    const [party] = await getDb()
      .insert(partiesTable)
      .values({
        type: "client_business",
        legalName: row.legalName,
        tin,
        tinValidated,
        cacNumber: cac,
        street: row.street ?? null,
        city: row.city ?? null,
        countryCode: "NG",
      })
      .returning({ id: partiesTable.id });
    const [engagement] = await getDb()
      .insert(engagementsTable)
      .values({
        firmId,
        clientPartyId: party.id,
        type: "retainer",
        status: "in_progress",
        title: row.engagementTitle ?? `${row.legalName} — compliance retainer`,
      })
      .returning({ id: engagementsTable.id });
    results.push({
      rowNumber,
      status: "created",
      partyId: party.id,
      engagementId: engagement.id,
      errors: [],
    });
  }

  const createdCount = results.filter((r) => r.status === "created").length;
  const existsCount = results.filter((r) => r.status === "exists").length;
  const invalidCount = results.filter((r) => r.status === "invalid").length;
  if (parsed.data.commit) {
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "clients.import",
      entityType: "firm",
      entityId: firmId,
      after: { rows: results.length, created: createdCount, exists: existsCount, invalid: invalidCount },
    });
  }
  res.json(
    ImportClientsResponse.parse({
      rowCount: results.length,
      createdCount,
      existsCount,
      invalidCount,
      committed: parsed.data.commit,
      rows: results,
    }),
  );
});

export default router;
