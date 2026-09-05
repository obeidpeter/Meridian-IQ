import type { Request, Response } from "express";
import { parseIdempotencyKey, type OperationCommand } from "./command";
import { executeOperation } from "./service";

// Call inside the existing tenant middleware, after contract and scope checks.
// The callback must use getDb()/the supplied tx, and must not send a response.
export async function executeHttpOperation(
  req: Request,
  res: Response,
  input: {
    command: OperationCommand;
    clientPartyId: string;
    payload: unknown;
    execute: Parameters<typeof executeOperation>[0]["execute"];
  },
): Promise<void> {
  const result = await executeOperation({
    ...input,
    principal: req.principal,
    idempotencyKey: parseIdempotencyKey(req.headers["x-idempotency-key"]),
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Operation-Id", result.operationId);
  res.setHeader("Idempotency-Replayed", String(result.replayed));
  res.status(result.statusCode).type("application/json").send(result.body);
}
