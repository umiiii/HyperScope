import { createHash } from "node:crypto";
import { ensureSchema, getDatabasePool } from "@/lib/db";

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

export function endpointHash(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function isValidPushSubscription(value: unknown): value is PushSubscriptionInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string") return false;
  if (typeof candidate.keys !== "object" || candidate.keys === null) return false;
  const keys = candidate.keys as Record<string, unknown>;

  try {
    const endpoint = new URL(candidate.endpoint);
    return (
      endpoint.protocol === "https:" &&
      typeof keys.p256dh === "string" &&
      keys.p256dh.length > 20 &&
      typeof keys.auth === "string" &&
      keys.auth.length > 8
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
