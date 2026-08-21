import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureSchema, getDatabasePool, withTransaction } from "@/lib/db";
import {
  detectPositionChanges,
  positionChangeDirection,
} from "@/lib/hyperliquid/diff";
import { fetchHyperliquidAccount } from "@/lib/hyperliquid/client";
import type {
  PositionChange,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";
import { deliverNotification } from "@/lib/notifications";
import {
  claimNextNotification,
  markNotificationSent,
  retryNotification,
} from "@/lib/repository/outbox";
import { getMonitorIntervalMs } from "@/lib/repository/addresses";
import { claimPushSlots, pushCooldownId } from "@/lib/repository/push-cooldowns";

type MonitorAddressRow = {
  id: string;
  address: string;
  label: string | null;
  active: boolean;
  last_checked_at: Date | null;
};

type StoredPositionRow = {
  dex: string;
  coin: string;
  size: string;
  entry_price: string | null;
  position_value: string;
  unrealized_pnl: string;
  return_on_equity: string;
  liquidation_price: string | null;
  margin_used: string;
  leverage_type: string;
  leverage_value: number;
  leverage_raw_usd: string | null;
  max_leverage: number | null;
};

type DexStateRow = {
  dex: string;
  last_snapshot_at: Date;
};

export type MonitorResult = {
  success: boolean;
  initialSnapshot: boolean;
  changes: PositionChange[];
  /** The subset of `changes` that was queued for push; the rest sat inside a
   *  cooldown window and only reached the position timeline. */
  notified: PositionChange[];
  error?: string;
};

function mapStoredPosition(row: StoredPositionRow): PositionSnapshot {
  return {
    dex: row.dex,
    coin: row.coin,
    size: row.size,
    entryPrice: row.entry_price,
    positionValue: row.position_value,
    unrealizedPnl: row.unrealized_pnl,
    returnOnEquity: row.return_on_equity,
    liquidationPrice: row.liquidation_price,
    marginUsed: row.margin_used,
    leverageType: row.leverage_type,
    leverageValue: row.leverage_value,
    leverageRawUsd: row.leverage_raw_usd,
    maxLeverage: row.max_leverage,
  };
}

function fingerprint(
  addressId: string,
  previousSnapshotAt: Date | null,
  change: PositionChange,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        addressId,
        previousSnapshotAt: previousSnapshotAt?.toISOString() ?? "initial",
        dex: change.dex,
        coin: change.coin,
        kind: change.kind,
        before: change.before,
        after: change.after,
      }),
    )
    .digest("hex");
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Hyperliquid 请求超时。";
    }
    return error.message.slice(0, 500);
  }
  return "仓位检查失败。";
}

async function loadStoredPositions(client: PoolClient, addressId: string) {
  const result = await client.query<StoredPositionRow>(
    `
      SELECT dex, coin, size, entry_price, position_value, unrealized_pnl,
        return_on_equity, liquidation_price, margin_used, leverage_type,
        leverage_value, leverage_raw_usd, max_leverage
      FROM positions
      WHERE address_id = $1
    `,
    [addressId],
  );
  return result.rows.map(mapStoredPosition);
}

async function replaceDexPositions(
  client: PoolClient,
  addressId: string,
  dex: string,
  positions: PositionSnapshot[],
) {
  await client.query(
    "DELETE FROM positions WHERE address_id = $1 AND dex = $2",
    [addressId, dex],
  );
  for (const position of positions) {
    await client.query(
      `
        INSERT INTO positions (
          address_id, dex, coin, size, entry_price, position_value, unrealized_pnl,
          return_on_equity, liquidation_price, margin_used, leverage_type,
          leverage_value, leverage_raw_usd, max_leverage, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      `,
      [
        addressId,
        dex,
        position.coin,
        position.size,
        position.entryPrice,
        position.positionValue,
        position.unrealizedPnl,
        position.returnOnEquity,
        position.liquidationPrice,
        position.marginUsed,
        position.leverageType,
        position.leverageValue,
        position.leverageRawUsd,
        position.maxLeverage,
      ],
    );
  }
}

/**
 * Keeps only the changes whose address+ticker+direction is out of its push
 * cooldown, and starts a fresh cooldown for each one kept. Everything filtered
 * out stays in `position_changes`, so the timeline keeps every change while the
 * device only hears about a given position side once per window.
 */
async function selectNotifiableChanges(
  client: PoolClient,
  addressId: string,
  changes: PositionChange[],
) {
  if (changes.length === 0) return [];

  const candidates = changes.map((change) => ({
    change,
    key: { coin: change.coin, direction: positionChangeDirection(change) },
  }));
  const claimed = await claimPushSlots(
    client,
    addressId,
    candidates.map((candidate) => candidate.key),
    new Date(),
  );

  return candidates
    .filter((candidate) => claimed.has(pushCooldownId(candidate.key)))
    .map((candidate) => candidate.change);
}

async function recordChanges(
  client: PoolClient,
  address: MonitorAddressRow,
  changes: PositionChange[],
  snapshotTimes: Record<string, number>,
  previousSnapshotTimes: Map<string, Date>,
) {
  const batchId = randomUUID();
  const accepted: PositionChange[] = [];

  for (const change of changes) {
    const result = await client.query(
      `
        INSERT INTO position_changes (
          id, address_id, batch_id, dex, coin, kind, summary, before_position,
          after_position, fingerprint, detected_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
        ON CONFLICT (fingerprint) DO NOTHING
      `,
      [
        randomUUID(),
        address.id,
        batchId,
        change.dex,
        change.coin,
        change.kind,
        change.summary,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
        fingerprint(
          address.id,
          previousSnapshotTimes.get(change.dex) ?? null,
          change,
        ),
        new Date(snapshotTimes[change.dex]),
      ],
    );
    if ((result.rowCount ?? 0) > 0) accepted.push(change);
  }

  const notified = await selectNotifiableChanges(client, address.id, accepted);

  if (notified.length > 0) {
    const displayName = address.label || `${address.address.slice(0, 6)}…${address.address.slice(-4)}`;
    const body =
      notified.length === 1
        ? notified[0].summary
        : `${notified[0].summary}，另有 ${notified.length - 1} 项变动`;
    await client.query(
      `
        INSERT INTO notification_outbox (
          id, address_id, title, body, target_url, tag
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        randomUUID(),
        address.id,
        `${displayName} · 仓位变动`,
        body,
        `/addresses/${address.id}`,
        `position-${address.id}-${batchId}`,
      ],
    );
  }

  return { accepted, notified };
}

export async function monitorAddress(addressId: string): Promise<MonitorResult> {
  await ensureSchema();
  const pool = getDatabasePool();
  const [addressResult, knownDexResult] = await Promise.all([
    pool.query<MonitorAddressRow>(
      `
        SELECT id, address, label, active, last_checked_at
        FROM monitored_addresses
        WHERE id = $1 AND active = TRUE
      `,
      [addressId],
    ),
    pool.query<{ dex: string }>(
      "SELECT dex FROM monitored_address_dex_states WHERE address_id = $1",
      [addressId],
    ),
  ]);
  const address = addressResult.rows[0];
  if (!address) throw new Error("监视地址不存在。");

  let snapshot;
  try {
    snapshot = await fetchHyperliquidAccount(
      address.address,
      knownDexResult.rows.map((row) => row.dex),
    );
  } catch (error) {
    const message = errorMessage(error);
    const nextCheckAt = new Date(Date.now() + getMonitorIntervalMs());
    await pool.query(
      `
        UPDATE monitored_addresses
        SET status = 'error', error_message = $2,
          next_check_at = $3,
          updated_at = NOW()
        WHERE id = $1
          AND (
            last_checked_at = $4
            OR (last_checked_at IS NULL AND $5::boolean)
          )
      `,
      [
        addressId,
        message,
        nextCheckAt,
        address.last_checked_at,
        address.last_checked_at === null,
      ],
    );
    return {
      success: false,
      initialSnapshot: false,
      changes: [],
      notified: [],
      error: message,
    };
  }

  return withTransaction(async (client) => {
    const lockedResult = await client.query<MonitorAddressRow>(
      `
        SELECT id, address, label, active, last_checked_at
        FROM monitored_addresses
        WHERE id = $1 AND active = TRUE
        FOR UPDATE
      `,
      [addressId],
    );
    const lockedAddress = lockedResult.rows[0];
    if (!lockedAddress) {
      return {
        success: false,
        initialSnapshot: false,
        changes: [],
        notified: [],
        error: "地址已停止监视。",
      };
    }
    const dexStateResult = await client.query<DexStateRow>(
      `
        SELECT dex, last_snapshot_at
        FROM monitored_address_dex_states
        WHERE address_id = $1
        FOR UPDATE
      `,
      [addressId],
    );
    const previousSnapshotTimes = new Map(
      dexStateResult.rows.map((row) => [row.dex, row.last_snapshot_at]),
    );
    const candidateTimes = Object.entries(snapshot.dexSnapshotTimes);
    const candidateDexes = new Set(candidateTimes.map(([dex]) => dex));
    const missesKnownDex = [...previousSnapshotTimes.keys()].some(
      (dex) => !candidateDexes.has(dex),
    );
    if (missesKnownDex) {
      return { success: true, initialSnapshot: false, changes: [], notified: [] };
    }
    const containsOlderSnapshot = candidateTimes.some(([dex, time]) => {
      const previousTime = previousSnapshotTimes.get(dex);
      return previousTime ? time < previousTime.getTime() : false;
    });
    if (containsOlderSnapshot) {
      return { success: true, initialSnapshot: false, changes: [], notified: [] };
    }
    const hasFreshSnapshot = candidateTimes.some(([dex, time]) => {
      const previousTime = previousSnapshotTimes.get(dex);
      return !previousTime || time > previousTime.getTime();
    });
    if (!hasFreshSnapshot) {
      return { success: true, initialSnapshot: false, changes: [], notified: [] };
    }

    const previousPositions = await loadStoredPositions(client, addressId);
    const initialSnapshot = previousSnapshotTimes.size === 0;
    const newDexes: string[] = [];
    const changes: PositionChange[] = [];

    for (const [dex, time] of candidateTimes) {
      const previousTime = previousSnapshotTimes.get(dex);
      if (previousTime && time <= previousTime.getTime()) continue;

      const currentDexPositions = snapshot.positions.filter(
        (position) => position.dex === dex,
      );
      if (!previousTime) {
        newDexes.push(dex);
      } else {
        changes.push(
          ...detectPositionChanges(
            previousPositions.filter((position) => position.dex === dex),
            currentDexPositions,
          ),
        );
      }

      await replaceDexPositions(client, addressId, dex, currentDexPositions);
      await client.query(
        `
          INSERT INTO monitored_address_dex_states (address_id, dex, last_snapshot_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (address_id, dex) DO UPDATE
          SET last_snapshot_at = EXCLUDED.last_snapshot_at
        `,
        [addressId, dex, new Date(time)],
      );
    }

    const { accepted: acceptedChanges, notified } = await recordChanges(
      client,
      lockedAddress,
      changes,
      snapshot.dexSnapshotTimes,
      previousSnapshotTimes,
    );

    if (initialSnapshot) {
      await client.query(
        `
          INSERT INTO position_changes (
            id, address_id, batch_id, coin, kind, summary, before_position,
            after_position, fingerprint, detected_at
          )
          VALUES ($1, $2, $3, NULL, 'monitor_started', $4, NULL, NULL, $5, $6)
          ON CONFLICT (fingerprint) DO NOTHING
        `,
        [
          randomUUID(),
          addressId,
          randomUUID(),
          `开始监视 · 当前 ${snapshot.positions.length} 个永续仓位`,
          createHash("sha256").update(`monitor-started:${addressId}`).digest("hex"),
          snapshot.fetchedAt,
        ],
      );
    } else if (newDexes.length > 0) {
      const dexLabels = newDexes.map((dex) => dex || "main").join("、");
      await client.query(
        `
          INSERT INTO position_changes (
            id, address_id, batch_id, dex, coin, kind, summary, before_position,
            after_position, fingerprint, detected_at
          )
          VALUES ($1, $2, $3, NULL, NULL, 'monitor_scope_updated', $4, NULL, NULL, $5, $6)
          ON CONFLICT (fingerprint) DO NOTHING
        `,
        [
          randomUUID(),
          addressId,
          randomUUID(),
          `已纳入 ${dexLabels} DEX · 新 DEX 当前 ${snapshot.positions.filter((position) => newDexes.includes(position.dex)).length} 个仓位`,
          createHash("sha256")
            .update(`monitor-scope:${addressId}:${newDexes.sort().join(",")}`)
            .digest("hex"),
          snapshot.fetchedAt,
        ],
      );
    }

    await client.query(
      `
        UPDATE monitored_addresses
        SET status = 'healthy', error_message = NULL, account_value = $2,
          withdrawable = $3, total_margin_used = $4, last_checked_at = $5,
          last_changed_at = CASE WHEN $6::boolean THEN $5 ELSE last_changed_at END,
          next_check_at = $7, updated_at = NOW()
        WHERE id = $1
      `,
      [
        addressId,
        snapshot.accountValue,
        snapshot.withdrawable,
        snapshot.totalMarginUsed,
        snapshot.fetchedAt,
        acceptedChanges.length > 0,
        new Date(Date.now() + getMonitorIntervalMs()),
      ],
    );

    return {
      success: true,
      initialSnapshot,
      changes: acceptedChanges,
      notified,
    };
  });
}

export async function listDueAddressIds(limit = 50) {
  await ensureSchema();
  const result = await getDatabasePool().query<{ id: string }>(
    `
      SELECT id
      FROM monitored_addresses
      WHERE active = TRUE AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map((row) => row.id);
}

export async function withMonitorLease(operation: () => Promise<void>) {
  await ensureSchema();
  const client = await getDatabasePool().connect();
  let acquired = false;
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(84519322) AS acquired",
    );
    acquired = Boolean(lockResult.rows[0]?.acquired);
    if (!acquired) return false;
    await operation();
    return true;
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock(84519322)").catch(() => undefined);
    }
    client.release();
  }
}

export async function updateWorkerState(
  state: "starting" | "running" | "idle" | "error" | "stopping",
  error: string | null = null,
) {
  await ensureSchema();
  await getDatabasePool().query(
    `
      INSERT INTO monitor_worker_state (
        id, state, last_started_at, last_completed_at, last_error, updated_at
      )
      VALUES (
        1, $1,
        CASE WHEN $1 IN ('starting', 'running') THEN NOW() ELSE NULL END,
        CASE WHEN $1 = 'idle' THEN NOW() ELSE NULL END,
        $2,
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        state = EXCLUDED.state,
        last_started_at = CASE
          WHEN $1 = 'running' THEN NOW()
          ELSE monitor_worker_state.last_started_at
        END,
        last_completed_at = CASE
          WHEN $1 = 'idle' THEN NOW()
          ELSE monitor_worker_state.last_completed_at
        END,
        last_error = $2,
        updated_at = NOW()
    `,
    [state, error],
  );
}

export async function drainNotificationOutbox(maxItems = 20) {
  for (let index = 0; index < maxItems; index += 1) {
    const notification = await claimNextNotification();
    if (!notification) return;
    try {
      const result = await deliverNotification(notification);
      if (result.transientFailures > 0 && result.delivered === 0) {
        await retryNotification(
          notification.id,
          "所有设备推送均暂时失败。",
          notification.attempts,
        );
      } else {
        await markNotificationSent(notification.id);
      }
    } catch (error) {
      await retryNotification(
        notification.id,
        errorMessage(error),
        notification.attempts,
      );
    }
  }
}
