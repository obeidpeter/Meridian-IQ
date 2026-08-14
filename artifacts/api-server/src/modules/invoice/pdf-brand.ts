import { eq } from "drizzle-orm";
import { getDb, firmsTable } from "@workspace/db";
import { themeWithBrandFallback } from "./pdf";

// The one query+fallback pair for every paper route (invoice PDF, compliance
// pack, obligation response pack, onboarding report): load the firm's stored
// theme and fold in the brand fallback the renderer expects. Lives beside
// pdf.ts rather than inside it because the renderer is deliberately DB-free;
// runs on getDb() so it executes inside the calling route's ambient
// transaction.
export interface FirmBrand {
  name: string | null;
  theme: Record<string, unknown>;
}

export async function loadFirmBrand(firmId: string): Promise<FirmBrand> {
  const [firm] = await getDb()
    .select({ name: firmsTable.name, theme: firmsTable.theme })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  return {
    name: firm?.name ?? null,
    theme: themeWithBrandFallback(firm?.theme, firm?.name),
  };
}
