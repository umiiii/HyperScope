import assert from "node:assert/strict";
import test from "node:test";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import webpush, { WebPushError } from "web-push";
import { SCHEMA_STATEMENTS } from "@/lib/db/schema";
import { deliverTestNotification } from "@/lib/notifications";
import {
  endpointHash,
  savePushSubscription,
  type PushSubscriptionInput,
} from "@/lib/repository/push-subscriptions";

function subscription(suffix: string): PushSubscriptionInput {
  return {
    endpoint: `https://web.push.apple.com/QP-${suffix}`,
    expirationTime: null,
    keys: {
      p256dh: `p256dh-${suffix}-key-that-is-long-enough-for-testing`,
      auth: `auth-${suffix}-key-long-enough`,
    },
  };
}

test("测试推送只调用当前设备订阅，不写入群发 outbox", async (t) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSubject = process.env.VAPID_SUBJECT;
  const previousPublicKey = process.env.VAPID_PUBLIC_KEY;
  const previousPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const originalSendNotification = webpush.sendNotification;
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

  process.env.DATABASE_URL = "postgresql://in-process-notification-test";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
  process.env.VAPID_PUBLIC_KEY = "A".repeat(88);
  process.env.VAPID_PRIVATE_KEY = "B".repeat(44);
  globalThis.hyperScopeDatabasePool = pool as unknown as Pool;
  globalThis.hyperScopeSchemaPromise = Promise.resolve();

  const sentEndpoints: string[] = [];
  let expiredEndpoint: string | null = null;
  webpush.sendNotification = async (target) => {
    if (target.endpoint === expiredEndpoint) {
      throw new WebPushError(
        "subscription gone",
        410,
        {} as never,
        "",
        target.endpoint,
      );
    }
    sentEndpoints.push(target.endpoint);
    return { statusCode: 201, body: "", headers: {} };
  };

  t.after(async () => {
    webpush.sendNotification = originalSendNotification;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSubject === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = previousSubject;
    if (previousPublicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = previousPublicKey;
    if (previousPrivateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = previousPrivateKey;
    await pool.end();
  });

  const currentDevice = subscription("current");
  const otherDevice = subscription("other");
  await savePushSubscription(currentDevice, "current-agent");
  await savePushSubscription(otherDevice, "other-agent");

  const result = await deliverTestNotification(currentDevice);
  assert.equal(result, "delivered");
  assert.deepEqual(sentEndpoints, [currentDevice.endpoint]);

  const outbox = await pool.query("SELECT 1 FROM notification_outbox");
  const successes = await pool.query(
    "SELECT endpoint, last_success_at FROM push_subscriptions ORDER BY endpoint",
  );
  assert.equal(outbox.rowCount, 0);
  assert.equal(
    successes.rows.find((row: { endpoint: string }) => row.endpoint === currentDevice.endpoint)
      ?.last_success_at instanceof Date,
    true,
  );
  assert.equal(
    successes.rows.find((row: { endpoint: string }) => row.endpoint === otherDevice.endpoint)
      ?.last_success_at,
    null,
  );

  const expiredDevice = subscription("expired");
  await savePushSubscription(expiredDevice, "expired-agent");
  expiredEndpoint = expiredDevice.endpoint;
  assert.equal(await deliverTestNotification(expiredDevice), "expired");
  const expiredRows = await pool.query(
    "SELECT 1 FROM push_subscriptions WHERE endpoint = $1",
    [expiredDevice.endpoint],
  );
  assert.equal(expiredRows.rowCount, 0);
  const retainedLimit = await pool.query(
    "SELECT 1 FROM push_test_limits WHERE endpoint_hash = $1",
    [endpointHash(expiredDevice.endpoint)],
  );
  assert.equal(retainedLimit.rowCount, 1);
});
