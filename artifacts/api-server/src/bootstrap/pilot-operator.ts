import assert from "node:assert/strict";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  getDb,
  membershipsTable,
  productionBootstrapClaimsTable,
  runInBypassContext,
  usersTable,
} from "@workspace/db";
import { appendAudit } from "../modules/audit/audit";
import {
  hashPassword,
  normalizeEmail,
  PRODUCTION_DEMO_EMAILS,
} from "../modules/auth/session";

const PILOT_OPERATOR_LOCK_ID = 748_201;
const PILOT_OPERATOR_CLAIM = "first-production-operator";
const MIN_PASSWORD_LENGTH = 16;

export interface PilotOperatorEnvironment {
  NODE_ENV?: string;
  PILOT_OPERATOR_EMAIL?: string;
  PILOT_OPERATOR_FULL_NAME?: string;
  PILOT_OPERATOR_PASSWORD?: string;
}

interface PilotOperatorConfig {
  email: string;
  fullName: string;
  password: string;
}

export interface PilotOperatorDependencies {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  isConsumed(): Promise<boolean>;
  findRealOperator(): Promise<{ id: string } | null>;
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  hashPassword(password: string): Promise<string>;
  createOperator(input: {
    email: string;
    fullName: string;
    passwordHash: string;
  }): Promise<{ id: string }>;
  consume(userId: string): Promise<void>;
  audit(userId: string, created: boolean): Promise<void>;
}

export type PilotOperatorProvisioningResult =
  | "disabled"
  | "already-provisioned"
  | "provisioned";

function bootstrapRequested(env: PilotOperatorEnvironment): boolean {
  return [
    env.PILOT_OPERATOR_EMAIL,
    env.PILOT_OPERATOR_FULL_NAME,
    env.PILOT_OPERATOR_PASSWORD,
  ].some((value) => typeof value === "string" && value.length > 0);
}

function readConfig(
  env: PilotOperatorEnvironment,
): PilotOperatorConfig {
  const values = [
    env.PILOT_OPERATOR_EMAIL,
    env.PILOT_OPERATOR_FULL_NAME,
    env.PILOT_OPERATOR_PASSWORD,
  ];
  assert.ok(
    values.every((value) => typeof value === "string" && value.length > 0),
    "pilot operator bootstrap requires email, full name and password together",
  );

  const email = normalizeEmail(env.PILOT_OPERATOR_EMAIL!);
  const fullName = env.PILOT_OPERATOR_FULL_NAME!.trim();
  const password = env.PILOT_OPERATOR_PASSWORD!;
  assert.match(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid pilot operator email");
  assert.ok(
    !PRODUCTION_DEMO_EMAILS.includes(
      email as (typeof PRODUCTION_DEMO_EMAILS)[number],
    ),
    "historical demo identities cannot be production operators",
  );
  assert.ok(
    fullName.length > 0 &&
      fullName.length <= 120 &&
      !/[\u0000-\u001f\u007f]/.test(fullName),
    "pilot operator full name is invalid",
  );
  assert.ok(
    password.length >= MIN_PASSWORD_LENGTH,
    `pilot operator password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  );
  assert.notEqual(
    password.toLowerCase(),
    email.toLowerCase(),
    "pilot operator password must not equal the email",
  );
  return { email, fullName, password };
}

function discardProcessPassword(env: PilotOperatorEnvironment): void {
  if (env === process.env) delete process.env.PILOT_OPERATOR_PASSWORD;
}

export const productionPilotOperatorDependencies: PilotOperatorDependencies = {
  withLock: (fn) =>
    runInBypassContext(async () => {
      await getDb().execute(
        sql`SELECT pg_advisory_xact_lock(${PILOT_OPERATOR_LOCK_ID})`,
      );
      // The advisory lock serializes claim access. Keep the immutable claims
      // table out of this stronger lock because meridian_app intentionally has
      // only SELECT/INSERT privileges on it.
      await getDb().execute(
        sql`LOCK TABLE users, memberships IN SHARE ROW EXCLUSIVE MODE`,
      );
      return fn();
    }),
  async isConsumed() {
    const [claim] = await getDb()
      .select({ key: productionBootstrapClaimsTable.key })
      .from(productionBootstrapClaimsTable)
      .where(eq(productionBootstrapClaimsTable.key, PILOT_OPERATOR_CLAIM))
      .limit(1);
    return Boolean(claim);
  },
  async findRealOperator() {
    const [operator] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .innerJoin(
        membershipsTable,
        eq(membershipsTable.userId, usersTable.id),
      )
      .where(
        and(
          eq(membershipsTable.role, "operator"),
          notInArray(usersTable.email, [...PRODUCTION_DEMO_EMAILS]),
        ),
      )
      .limit(1);
    return operator ?? null;
  },
  async findUserByEmail(email) {
    const [user] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    return user ?? null;
  },
  hashPassword,
  async createOperator(input) {
    const [user] = await getDb()
      .insert(usersTable)
      .values({
        email: input.email,
        fullName: input.fullName,
        passwordHash: input.passwordHash,
      })
      .returning({ id: usersTable.id });
    assert.ok(user, "pilot operator user was not created");
    await getDb().insert(membershipsTable).values({
      userId: user.id,
      firmId: null,
      role: "operator",
      clientPartyId: null,
      buyerPartyId: null,
    });
    return user;
  },
  async consume(userId) {
    await getDb().insert(productionBootstrapClaimsTable).values({
      key: PILOT_OPERATOR_CLAIM,
      operatorUserId: userId,
    });
  },
  async audit(userId, created) {
    await appendAudit({
      actorId: null,
      actorRole: null,
      firmId: null,
      action: created
        ? "operator.bootstrap"
        : "operator.bootstrap.consume_existing",
      entityType: "user",
      entityId: userId,
      after: {
        role: "operator",
        source: "one-time-production-bootstrap",
        created,
      },
    });
  },
};

export async function provisionProductionPilotOperator(
  env: PilotOperatorEnvironment = process.env,
  dependencies: PilotOperatorDependencies = productionPilotOperatorDependencies,
): Promise<PilotOperatorProvisioningResult> {
  if (env.NODE_ENV !== "production" || !bootstrapRequested(env)) {
    return "disabled";
  }

  return dependencies.withLock(async () => {
    if (await dependencies.isConsumed()) {
      discardProcessPassword(env);
      return "already-provisioned";
    }
    const existingOperator = await dependencies.findRealOperator();
    if (existingOperator) {
      await dependencies.audit(existingOperator.id, false);
      await dependencies.consume(existingOperator.id);
      discardProcessPassword(env);
      return "already-provisioned";
    }

    const config = readConfig(env);
    assert.equal(
      await dependencies.findUserByEmail(config.email),
      null,
      "pilot operator email already belongs to a non-operator account",
    );
    const passwordHash = await dependencies.hashPassword(config.password);
    const user = await dependencies.createOperator({
      email: config.email,
      fullName: config.fullName,
      passwordHash,
    });
    await dependencies.audit(user.id, true);
    await dependencies.consume(user.id);
    discardProcessPassword(env);
    return "provisioned";
  });
}