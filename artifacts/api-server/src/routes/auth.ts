import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, membershipsTable } from "@workspace/db";
import { LoginBody, LoginResponse } from "@workspace/api-zod";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac";
import {
  SESSION_COOKIE,
  authenticate,
  issueSessionToken,
} from "../modules/auth/session";
import { appendAudit } from "../modules/audit/audit";

// First-party session sign-in (SEC-02). Sets an HttpOnly, SameSite=Lax cookie;
// the principal middleware resolves it on subsequent requests. Both endpoints
// are on the PUBLIC_PATHS allowlist (login must work unauthenticated; logout
// must work even with an expired session).

const router: IRouter = Router();

function cookieOptions(req: { secure?: boolean; headers: Record<string, unknown> }) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "");
  const secure = Boolean(req.secure) || forwardedProto.includes("https");
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await authenticate(parsed.data.email, parsed.data.password);
  if (!result) {
    // Uniform message: never reveal whether the email exists.
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const memberships = await getDb()
    .select({
      firmId: membershipsTable.firmId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      buyerPartyId: membershipsTable.buyerPartyId,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, result.userId));
  if (memberships.length === 0) {
    res.status(401).json({ error: "Account has no active membership" });
    return;
  }
  const membership = memberships[0];
  const token = await issueSessionToken(result.userId);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  await appendAudit({
    actorId: result.userId,
    firmId: membership.firmId,
    action: "auth.login",
    entityType: "user",
    entityId: result.userId,
    after: { role: membership.role },
  });
  res.json(
    LoginResponse.parse({
      userId: result.userId,
      role: membership.role,
      firmId: membership.firmId,
      clientPartyId: membership.clientPartyId,
      buyerPartyId: membership.buyerPartyId,
      capabilities: ROLE_CAPABILITIES[membership.role] ?? [],
    }),
  );
});

router.post("/auth/logout", (req, res): void => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.sendStatus(204);
});

export default router;
