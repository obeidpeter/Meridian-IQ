import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPilotOperatorSettings,
  provisionProductionPilotOperator,
  type PilotOperatorDependencies,
  type PilotOperatorEnvironment,
} from "./pilot-operator";

const validEnv: PilotOperatorEnvironment = {
  NODE_ENV: "production",
  PILOT_OPERATOR_EMAIL: "pilot@example.com",
  PILOT_OPERATOR_FULL_NAME: "Pilot Operator",
  PILOT_OPERATOR_PASSWORD: "a-unique-password-1234",
};

function dependencies(
  overrides: Partial<PilotOperatorDependencies> = {},
): PilotOperatorDependencies {
  return {
    withLock: (fn) => fn(),
    isConsumed: async () => false,
    findRealOperator: async () => null,
    findUserByEmail: async () => null,
    hashPassword: async () => "hashed",
    createOperator: async () => ({ id: "operator-id" }),
    consume: async () => undefined,
    audit: async () => undefined,
    ...overrides,
  };
}

test("is inert outside production and when bootstrap settings are absent", async () => {
  assert.equal(
    await provisionProductionPilotOperator(
      { ...validEnv, NODE_ENV: "development" },
      dependencies({
        withLock: async () => {
          throw new Error("must not open a transaction");
        },
      }),
    ),
    "disabled",
  );
  assert.equal(
    await provisionProductionPilotOperator(
      { NODE_ENV: "production" },
      dependencies(),
    ),
    "disabled",
  );
});

test("rejects partial, weak and historical demo credentials without throwing (R111)", async () => {
  // A settings problem must never reach the boot retry loop: the result is a
  // verdict, not an exception, and no credential work happens.
  for (const env of [
    { NODE_ENV: "production", PILOT_OPERATOR_EMAIL: "pilot@example.com" },
    { ...validEnv, PILOT_OPERATOR_PASSWORD: "too-short" },
    { ...validEnv, PILOT_OPERATOR_EMAIL: "ops@valo.example" },
    { ...validEnv, PILOT_OPERATOR_EMAIL: "not-an-address" },
    { ...validEnv, PILOT_OPERATOR_FULL_NAME: "   " },
  ] satisfies PilotOperatorEnvironment[]) {
    const result = await provisionProductionPilotOperator(
      env,
      dependencies({
        hashPassword: async () => {
          throw new Error("must not hash a rejected password");
        },
        createOperator: async () => {
          throw new Error("must not create an operator");
        },
      }),
    );
    assert.equal(result, "rejected");
  }
});

test("settings verdicts are stable phrases that never carry a value", () => {
  const secret = "a-unique-password-1234";
  const cases: [PilotOperatorEnvironment, RegExp][] = [
    [
      { NODE_ENV: "production", PILOT_OPERATOR_EMAIL: "pilot@example.com" },
      /set together/,
    ],
    [
      { ...validEnv, PILOT_OPERATOR_PASSWORD: "too-short" },
      /at least 16 characters/,
    ],
    [
      { ...validEnv, PILOT_OPERATOR_EMAIL: "ops@valo.example" },
      /historical demo identities/,
    ],
    [
      {
        ...validEnv,
        PILOT_OPERATOR_PASSWORD: "PILOT@EXAMPLE.COM",
        PILOT_OPERATOR_EMAIL: "pilot@example.com",
      },
      /must not equal the email/,
    ],
  ];
  for (const [env, expected] of cases) {
    const verdict = checkPilotOperatorSettings(env);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.match(verdict.reason, expected);
      assert.doesNotMatch(verdict.reason, /example\.com|pilot@|too-short/i);
      assert.equal(verdict.reason.includes(secret), false);
    }
  }
  const valid = checkPilotOperatorSettings(validEnv);
  assert.equal(valid.ok, true);
});

test("a consumed claim makes even partial retained settings inert", async () => {
  let credentialWork = false;
  const result = await provisionProductionPilotOperator(
    { NODE_ENV: "production", PILOT_OPERATOR_EMAIL: "left-behind@example.com" },
    dependencies({
      isConsumed: async () => true,
      findRealOperator: async () => {
        credentialWork = true;
        return null;
      },
      findUserByEmail: async () => {
        credentialWork = true;
        return null;
      },
      hashPassword: async () => {
        credentialWork = true;
        return "hashed";
      },
    }),
  );
  assert.equal(result, "already-provisioned");
  assert.equal(credentialWork, false);
});

test("an existing real operator permanently consumes the bootstrap", async () => {
  const calls: string[] = [];
  const result = await provisionProductionPilotOperator(
    validEnv,
    dependencies({
      findRealOperator: async () => ({ id: "existing-operator" }),
      audit: async (id, created) => {
        calls.push(`audit:${id}:${created}`);
      },
      consume: async (id) => {
        calls.push(`consume:${id}`);
      },
      findUserByEmail: async () => {
        throw new Error("must not inspect bootstrap email");
      },
      hashPassword: async () => {
        throw new Error("must not hash bootstrap password");
      },
    }),
  );
  assert.equal(result, "already-provisioned");
  assert.deepEqual(calls, [
    "audit:existing-operator:false",
    "consume:existing-operator",
  ]);
});

test("refuses to elevate an existing non-operator user, without throwing", async () => {
  let created = false;
  const result = await provisionProductionPilotOperator(
    validEnv,
    dependencies({
      findUserByEmail: async () => ({ id: "existing-user" }),
      createOperator: async () => {
        created = true;
        return { id: "never" };
      },
    }),
  );
  assert.equal(result, "rejected");
  assert.equal(created, false);
});

test("creates and audits exactly one operator inside the lock", async () => {
  const calls: string[] = [];
  const result = await provisionProductionPilotOperator(
    validEnv,
    dependencies({
      withLock: async (fn) => {
        calls.push("lock");
        return fn();
      },
      isConsumed: async () => {
        calls.push("check-claim");
        return false;
      },
      findRealOperator: async () => {
        calls.push("check-operator");
        return null;
      },
      findUserByEmail: async (email) => {
        calls.push(`check-user:${email}`);
        return null;
      },
      hashPassword: async (password) => {
        calls.push(`hash:${password.length}`);
        return "safe-hash";
      },
      createOperator: async (input) => {
        calls.push(
          `create:${input.email}:${input.fullName}:${input.passwordHash}`,
        );
        return { id: "new-operator" };
      },
      audit: async (userId, created) => {
        calls.push(`audit:${userId}:${created}`);
      },
      consume: async (userId) => {
        calls.push(`consume:${userId}`);
      },
    }),
  );
  assert.equal(result, "provisioned");
  assert.deepEqual(calls, [
    "lock",
    "check-claim",
    "check-operator",
    "check-user:pilot@example.com",
    "hash:22",
    "create:pilot@example.com:Pilot Operator:safe-hash",
    "audit:new-operator:true",
    "consume:new-operator",
  ]);
});
