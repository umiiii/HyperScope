import { createHash } from "node:crypto";
import {
  ensureSchema,
  getDatabasePool,
  withTransaction,
} from "@/lib/db";

export type StoredPushSubscription = {
  endpointHash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
};

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type TestPushClaim =
  | { status: "claimed"; subscription: StoredPushSubscription }
  | { status: "cooldown" | "expired" | "missing" | "rate_limited" };

export function endpointHash(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

function isKnownPushService(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "web.push.apple.com" ||
    normalized === "fcm.googleapis.com" ||
    normalized === "android.googleapis.com" ||
    normalized === "updates.push.services.mozilla.com" ||
    normalized.endsWith(".notify.windows.com")
  );
}

export function isValidPushSubscription(value: unknown): value is PushSubscriptionInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string") return false;
  if (typeof candidate.keys !== "object" || candidate.keys === null) return false;
  const keys = candidate.keys as Record<string, unknown>;

  try {
    const endpoint = new URL(candidate.endpoint);
    const expirationTime = candidate.expirationTime;
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === "" &&
      isKnownPushService(endpoint.hostname) &&
      candidate.endpoint.length <= 4_096 &&
      typeof keys.p256dh === "string" &&
      keys.p256dh.length > 20 &&
      keys.p256dh.length <= 512 &&
      typeof keys.auth === "string" &&
      keys.auth.length > 8 &&
      keys.auth.length <= 256 &&
      (expirationTime === undefined ||
        expirationTime === null ||
        (typeof expirationTime === "number" &&
          Number.isSafeInteger(expirationTime) &&
          expirationTime > 0))
    );
  } catch {
    return false;
  }
}

export async function savePushSubscription(
  subscription: PushSubscriptionInput,
  userAgent: string | null,
) {
  await ensureSchema();
  const hash = endpointHash(subscription.endpoint);
  await getDatabasePool().query(
    `
      INSERT INTO push_subscriptions (
        endpoint_hash, endpoint, p256dh, auth, expiration_time, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (endpoint_hash) DO UPDATE SET
        endpoint = EXCLUDED.endpoint,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        expiration_time = EXCLUDED.expiration_time,
        user_agent = EXCLUDED.user_agent,
        failure_count = 0,
        updated_at = NOW()
    `,
    [
      hash,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.expirationTime ?? null,
      userAgent,
    ],
  );
}

export async function removePushSubscription(endpoint: string) {
  await ensureSchema();
  const result = await getDatabasePool().query(
    "DELETE FROM push_subscriptions WHERE endpoint_hash = $1",
    [endpointHash(endpoint)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listPushSubscriptions(): Promise<StoredPushSubscription[]> {
  await ensureSchema();
  const result = await getDatabasePool().query<{
    endpoint_hash: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    expiration_time: string | null;
  }>(`
    SELECT endpoint_hash, endpoint, p256dh, auth, expiration_time
    FROM push_subscriptions
    ORDER BY created_at ASC
  `);

  return result.rows.map((row) => ({
    endpointHash: row.endpoint_hash,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    expirationTime: row.expiration_time ? Number(row.expiration_time) : null,
  }));
}

export async function claimPushSubscriptionForTest(
  subscription: PushSubscriptionInput,
): Promise<TestPushClaim> {
  const hash = endpointHash(subscription.endpoint);
  const now = Date.now();

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(84519324)");

    const existing = await client.query<{
      endpoint_hash: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      expiration_time: string | null;
    }>(
      `
        SELECT endpoint_hash, endpoint, p256dh, auth, expiration_time
        FROM push_subscriptions
        WHERE endpoint_hash = $1 AND p256dh = $2 AND auth = $3
        FOR UPDATE
      `,
      [hash, subscription.keys.p256dh, subscription.keys.auth],
    );
    const stored = existing.rows[0];
    if (!stored) return { status: "missing" };

    if (stored.expiration_time && Number(stored.expiration_time) <= now) {
      await client.query(
        `
          DELETE FROM push_subscriptions
          WHERE endpoint_hash = $1 AND p256dh = $2 AND auth = $3
        `,
        [hash, subscription.keys.p256dh, subscription.keys.auth],
      );
      return { status: "expired" };
    }

    const deviceLimit = await client.query<{ limited: boolean }>(
      `
        SELECT (last_attempt_at > NOW() - INTERVAL '1 minute') AS limited
        FROM push_test_limits
        WHERE endpoint_hash = $1
      `,
      [hash],
    );
    if (deviceLimit.rows[0]?.limited) return { status: "cooldown" };

    await client.query(
      "DELETE FROM push_test_limits WHERE last_attempt_at <= NOW() - INTERVAL '1 day'",
    );
    const globalRate = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM push_test_limits
      WHERE last_attempt_at > NOW() - INTERVAL '1 minute'
    `);
    if (Number(globalRate.rows[0]?.count ?? 0) >= 20) {
      return { status: "rate_limited" };
    }

    await client.query(
      `
        INSERT INTO push_test_limits (endpoint_hash, last_attempt_at)
        VALUES ($1, NOW())
        ON CONFLICT (endpoint_hash) DO UPDATE SET
          last_attempt_at = EXCLUDED.last_attempt_at,
          updated_at = NOW()
      `,
      [hash],
    );

    return {
      status: "claimed",
      subscription: {
        endpointHash: stored.endpoint_hash,
        endpoint: stored.endpoint,
        p256dh: stored.p256dh,
        auth: stored.auth,
        expirationTime: stored.expiration_time ? Number(stored.expiration_time) : null,
      },
    };
  });
}

export async function markPushSuccess(hash: string) {
  await getDatabasePool().query(
    `
      UPDATE push_subscriptions
      SET failure_count = 0, last_success_at = NOW(), updated_at = NOW()
      WHERE endpoint_hash = $1
    `,
    [hash],
  );
}

export async function markPushFailure(hash: string) {
  await getDatabasePool().query(
    `
      UPDATE push_subscriptions
      SET failure_count = failure_count + 1, updated_at = NOW()
      WHERE endpoint_hash = $1
    `,
    [hash],
  );
}

export async function removePushSubscriptionByHash(hash: string) {
  await getDatabasePool().query(
    "DELETE FROM push_subscriptions WHERE endpoint_hash = $1",
    [hash],
  );
}
