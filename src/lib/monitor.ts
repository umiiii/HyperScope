import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureSchema, getDatabasePool, withTransaction } from "@/lib/db";
import { detectPositionChanges } from "@/lib/hyperliquid/diff";
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

type MonitorAddressRow = {
  id: string;
  address: string;
  label: string | null;
  active: boolean;
  last_checked_at: Date | null;
};

type StoredPositionRow = {
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

export type MonitorResult = {
  success: boolean;
  initialSnapshot: boolean;
  changes: PositionChange[];
  error?: string;
};

function mapStoredPosition(row: StoredPositionRow): PositionSnapshot {
  return {
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
  previousCheckedAt: Date | null,
  change: PositionChange,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        addressId,
        previousCheckedAt: previousCheckedAt?.toISOString() ?? "initial",
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
      SELECT coin, size, entry_price, position_value, unrealized_pnl,
        return_on_equity, liquidation_price, margin_used, leverage_type,
        leverage_value, leverage_raw_usd, max_leverage
      FROM positions
      WHERE address_id = $1
    `,
    [addressId],
  );
  return result.rows.map(mapStoredPosition);
}

async function replacePositions(
  client: PoolClient,
  addressId: string,
  positions: PositionSnapshot[],
) {
  await client.query("DELETE FROM positions WHERE address_id = $1", [addressId]);
  for (const position of positions) {
    await client.query(
      `
        INSERT INTO positions (
          address_id, coin, size, entry_price, position_value, unrealized_pnl,
          return_on_equity, liquidation_price, margin_used, leverage_type,
          leverage_value, leverage_raw_usd, max_leverage, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      `,
      [
        addressId,
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

async function recordChanges(
  client: PoolClient,
  address: MonitorAddressRow,
  changes: PositionChange[],
  detectedAt: Date,
) {
  const batchId = randomUUID();
  const accepted: PositionChange[] = [];

  for (const change of changes) {
    const result = await client.query(
      `
        INSERT INTO position_changes (
          id, address_id, batch_id, coin, kind, summary, before_position,
          after_position, fingerprint, detected_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
        ON CONFLICT (fingerprint) DO NOTHING
      `,
      [
        randomUUID(),
        address.id,
        batchId,
        change.coin,
        change.kind,
        change.summary,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
        fingerprint(address.id, address.last_checked_at, change),
        detectedAt,
      ],
    );
    if ((result.rowCount ?? 0) > 0) accepted.push(change);
  }

  if (accepted.length > 0) {
    const displayName = address.label || `${address.address.slice(0, 6)}…${address.address.slice(-4)}`;
    const body =
      accepted.length === 1
        ? accepted[0].summary
        : `${accepted[0].summary}，另有 ${accepted.length - 1} 项变动`;
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

  return accepted;
}

export async function monitorAddress(addressId: string): Promise<MonitorResult> {
  await ensureSchema();
  const pool = getDatabasePool();
  const addressResult = await pool.query<MonitorAddressRow>(
    `
      SELECT id, address, label, active, last_checked_at
      FROM monitored_addresses
      WHERE id = $1 AND active = TRUE
    `,
    [addressId],
  );
  const address = addressResult.rows[0];
  if (!address) throw new Error("监视地址不存在。");

  let snapshot;
  try {
    snapshot = await fetchHyperliquidAccount(address.address);
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
    return { success: false, initialSnapshot: false, changes: [], error: message };
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
      return { success: false, initialSnapshot: false, changes: [], error: "地址已停止监视。" };
    }
    if (
      lockedAddress.last_checked_at &&
      lockedAddress.last_checked_at >= snapshot.fetchedAt
    ) {
      return { success: true, initialSnapshot: false, changes: [] };
    }

    const previousPositions = await loadStoredPositions(client, addressId);
    const initialSnapshot = lockedAddress.last_checked_at === null;
    const changes = initialSnapshot
      ? []
      : detectPositionChanges(previousPositions, snapshot.positions);
    const acceptedChanges = initialSnapshot
      ? []
      : await recordChanges(client, lockedAddress, changes, snapshot.fetchedAt);

    await replacePositions(client, addressId, snapshot.positions);

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
