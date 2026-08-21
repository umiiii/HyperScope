import type { PoolClient } from "pg";
import type { PositionDirection } from "@/lib/hyperliquid/diff";

/** One muted slot: a single address, a single ticker, a single direction. */
export type PushCooldownKey = {
  coin: string;
  direction: PositionDirection;
};

export const DEFAULT_PUSH_DEDUP_WINDOW_MS = 600_000;

/** Cooldown rows this far past the window are dead weight; a claim sweeps the
 *  ones belonging to the address it is claiming for. */
const COOLDOWN_RETENTION_MS = 86_400_000;

export function pushCooldownId(key: PushCooldownKey) {
  return `${key.coin}\u0000${key.direction}`;
}

/** How long one address+ticker+direction stays muted after a push. Setting
 *  `PUSH_DEDUP_WINDOW_MS=0` pushes every detected change again. */
export function getPushDedupWindowMs() {
  const configured = Number(
    process.env.PUSH_DEDUP_WINDOW_MS || DEFAULT_PUSH_DEDUP_WINDOW_MS,
  );
  return Number.isFinite(configured)
    ? Math.max(0, Math.floor(configured))
    : DEFAULT_PUSH_DEDUP_WINDOW_MS;
}

/**
 * Reserves the push slot of every key that is outside its cooldown window and
 * returns those keys as `pushCooldownId` values. Keys still inside the window
 * are left untouched, so a muted change never extends its own silence.
 *
 * Runs on the caller's client: `monitorAddress` already holds the address row
 * `FOR UPDATE`, which serialises the read-then-claim against any other check of
 * the same address.
 */
export async function claimPushSlots(
  client: PoolClient,
  addressId: string,
  keys: PushCooldownKey[],
  now: Date,
) {
  const claimed = new Set<string>();
  const pending = new Map<string, PushCooldownKey>();
  for (const key of keys) pending.set(pushCooldownId(key), key);
  if (pending.size === 0) return claimed;

  const windowMs = getPushDedupWindowMs();
  const muted = await client.query<{ coin: string; direction: PositionDirection }>(
    `
      SELECT coin, direction
      FROM notification_cooldowns
      WHERE address_id = $1 AND last_pushed_at > $2
    `,
    [addressId, new Date(now.getTime() - windowMs)],
  );
  const mutedIds = new Set(muted.rows.map((row) => pushCooldownId(row)));

  for (const [id, key] of pending) {
    if (mutedIds.has(id)) continue;
    await client.query(
      `
        INSERT INTO notification_cooldowns (address_id, coin, direction, last_pushed_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (address_id, coin, direction) DO UPDATE SET
          last_pushed_at = EXCLUDED.last_pushed_at,
          updated_at = NOW()
      `,
      [addressId, key.coin, key.direction, now],
    );
    claimed.add(id);
  }

  if (claimed.size > 0) {
    await client.query(
      `
        DELETE FROM notification_cooldowns
        WHERE address_id = $1 AND last_pushed_at <= $2
      `,
      [addressId, new Date(now.getTime() - Math.max(windowMs, COOLDOWN_RETENTION_MS))],
    );
  }

  return claimed;
}
