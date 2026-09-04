import { z } from "zod";

const field = z.string().max(10_000);
// An unfinished form is intentionally less strict than an invoice command.
export const DraftContent = z
  .object({
    invoiceNumber: field,
    buyerPartyId: z.union([z.string().uuid(), z.literal("")]),
    issueDate: z.string().max(32),
    dueDate: z.string().max(32),
    currency: z.string().max(16),
    fxRateToNgn: z.string().max(128),
    whtCategory: z.string().max(128),
    lines: z
      .array(
        z
          .object({
            description: field,
            quantity: z.string().max(128),
            unitPrice: z.string().max(128),
            vatRate: z.string().max(128),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const DraftScopeQuery = z.object({ clientPartyId: z.string().uuid() });
export const DraftListQuery = DraftScopeQuery.extend({
  offset: z.coerce.number().int().min(0).default(0),
});
export const DraftParams = z.object({ id: z.string().uuid() });
export const DraftWriteBody = z
  .object({
    clientPartyId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    writeId: z.string().uuid(),
    draft: DraftContent,
  })
  .strict();
export const DraftDeleteBody = DraftWriteBody.omit({
  draft: true,
  writeId: true,
});
export type DraftWrite = z.infer<typeof DraftWriteBody>;
