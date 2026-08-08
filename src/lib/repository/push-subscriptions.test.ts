import assert from "node:assert/strict";
import test from "node:test";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import { SCHEMA_STATEMENTS } from "@/lib/db/schema";
import {
  claimPushSubscriptionForTest,
  isValidPushSubscription,
  removePushSubscription,
  savePushSubscription,
  type PushSubscriptionInput,
} from "@/lib/repository/push-subscriptions";

function subscription(
  overrides: Partial<PushSubscriptionInput> = {},
): PushSubscriptionInput {
  return {
    endpoint: "https://web.push.apple.com/QP-test-endpoint",
    expirationTime: null,
    keys: {
      p256dh: "p256dh-test-key-that-is-long-enough-for-validation",
      auth: "auth-test-key-long-enough",
    },
    ...overrides,
  };
}

test("推送订阅只接受已知浏览器推送服务", () => {
  assert.equal(isValidPushSubscription(subscription()), true);
  assert.equal(
    isValidPushSubscription(
      subscription({ endpoint: "https://attacker.example/push-endpoint" }),
    ),
    false,
  );
});

async function setupDatabase() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  });
  for (const statement of SCHEMA_STATEMENTS) database.public.none(statement);
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();

  process.env.DATABASE_URL = "postgresql://in-process-push-test";
  globalThis.hyperScopeDatabasePool = pool as unknown as Pool;
  globalThis.hyperScopeSchemaPromise = Promise.resolve();
  return pool;
}

test("测试推送只认完整订阅密钥，并原子执行设备冷却", async (t) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  const stored = subscription();
  await savePushSubscription(stored, "test-agent");

  const wrongKeys = await claimPushSubscriptionForTest(
    subscription({ keys: { ...stored.keys, auth: "different-auth-key" } }),
  );
  assert.equal(wrongKeys.status, "missing");

  const first = await claimPushSubscriptionForTest(stored);
  assert.equal(first.status, "claimed");
  if (first.status === "claimed") {
    assert.equal(first.subscription.endpoint, stored.endpoint);
    assert.equal(first.subscription.auth, stored.keys.auth);
  }

  await removePushSubscription(stored.endpoint);
  await savePushSubscription(stored, "test-agent-reregistered");
  const repeated = await claimPushSubscriptionForTest(stored);
  assert.equal(repeated.status, "cooldown");
});

test("删除订阅不会重置全局测试推送限额", async (t) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  for (let index = 0; index < 20; index += 1) {
    const candidate = subscription({
      endpoint: `https://web.push.apple.com/QP-global-${index}`,
      keys: {
        p256dh: `p256dh-global-${index}-key-that-is-long-enough`,
        auth: `auth-global-${index}-key-long-enough`,
      },
    });
    await savePushSubscription(candidate, "global-limit-test");
    assert.equal((await claimPushSubscriptionForTest(candidate)).status, "claimed");
    await removePushSubscription(candidate.endpoint);
  }

  const twentyFirst = subscription({
    endpoint: "https://web.push.apple.com/QP-global-20",
  });
  await savePushSubscription(twentyFirst, "global-limit-test");
  assert.equal(
    (await claimPushSubscriptionForTest(twentyFirst)).status,
    "rate_limited",
  );
});

test("测试推送会清理已过期的当前设备订阅", async (t) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  const expired = subscription({ expirationTime: Date.now() - 1_000 });
  await savePushSubscription(expired, "test-agent");
  const result = await claimPushSubscriptionForTest(expired);
  assert.equal(result.status, "expired");

  const remaining = await pool.query("SELECT 1 FROM push_subscriptions");
  assert.equal(remaining.rowCount, 0);
});
