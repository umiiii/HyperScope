import { randomUUID } from "node:crypto";
import { ensureSchema, getDatabasePool, withTransaction } from "@/lib/db";
import type {
  AddressDetail,
  AddressSummary,
  DashboardData,
  PositionEvent,
  WorkerStatus,
} from "@/lib/domain";
import type { PositionSnapshot } from "@/lib/hyperliquid/types";

type AddressRow = {
  id: string;
  address: string;
  label: string | null;
  status: "pending" | "healthy" | "error";
  error_message: string | null;
  account_value: string;
  withdrawable: string;
  total_margin_used: string;
  position_count: number | string;
  unrealized_pnl: string;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  created_at: Date;
};

type PositionRow = {
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

type EventRow = {
  id: string;
  dex: string | null;
  coin: string | null;
  kind: PositionEvent["kind"];
  summary: string;
  before_position: PositionSnapshot | null;
  after_position: PositionSnapshot | null;
  detected_at: Date;
};

type WorkerRow = {
  state: string;
  last_started_at: Date | null;
  last_completed_at: Date | null;
  last_error: string | null;
  updated_at: Date;
};

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function mapAddress(row: AddressRow): AddressSummary {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    status: row.status,
    errorMessage: row.error_message,
    accountValue: row.account_value,
    withdrawable: row.withdrawable,
    totalMarginUsed: row.total_margin_used,
    positionCount: Number(row.position_count),
    unrealizedPnl: row.unrealized_pnl,
    lastCheckedAt: iso(row.last_checked_at),
    lastChangedAt: iso(row.last_changed_at),
    createdAt: row.created_at.toISOString(),
  };
}

function mapPosition(row: PositionRow): PositionSnapshot {
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

function normalizeHistoricalPosition(position: PositionSnapshot | null) {
  if (!position) return null;
  return {
    ...position,
    dex: typeof position.dex === "string" ? position.dex : "",
  };
}

export function getMonitorIntervalMs() {
  const configured = Number(process.env.MONITOR_INTERVAL_MS || 60_000);
  return Number.isFinite(configured) ? Math.max(10_000, Math.floor(configured)) : 60_000;
}

export async function listDashboardData(): Promise<DashboardData> {
  await ensureSchema();
  const pool = getDatabasePool();
  const [addressResult, workerResult] = await Promise.all([
    pool.query<AddressRow>(`
      SELECT
        a.id,
        a.address,
        a.label,
        a.status,
        a.error_message,
        a.account_value,
        a.withdrawable,
        a.total_margin_used,
        a.last_checked_at,
        a.last_changed_at,
        a.created_at,
        COUNT(p.coin)::int AS position_count,
        COALESCE(SUM(p.unrealized_pnl::numeric), 0)::text AS unrealized_pnl
      FROM monitored_addresses a
      LEFT JOIN positions p ON p.address_id = a.id
      WHERE a.active = TRUE
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `),
    pool.query<WorkerRow>(`
      SELECT state, last_started_at, last_completed_at, last_error, updated_at
      FROM monitor_worker_state
      WHERE id = 1
    `),
  ]);

  const workerRow = workerResult.rows[0];
  const worker: WorkerStatus = workerRow
    ? {
        state: workerRow.state,
        lastStartedAt: iso(workerRow.last_started_at),
        lastCompletedAt: iso(workerRow.last_completed_at),
        lastError: workerRow.last_error,
        updatedAt: workerRow.updated_at.toISOString(),
      }
    : null;

  return {
    addresses: addressResult.rows.map(mapAddress),
    worker,
    monitorIntervalMs: getMonitorIntervalMs(),
  };
}

export async function getAddressDetail(id: string): Promise<AddressDetail | null> {
  await ensureSchema();
  const pool = getDatabasePool();
  const [addressResult, positionResult, eventResult] = await Promise.all([
    pool.query<AddressRow>(
      `
        SELECT
          a.id,
          a.address,
          a.label,
          a.status,
          a.error_message,
          a.account_value,
          a.withdrawable,
          a.total_margin_used,
          a.last_checked_at,
          a.last_changed_at,
          a.created_at,
          COUNT(p.coin)::int AS position_count,
          COALESCE(SUM(p.unrealized_pnl::numeric), 0)::text AS unrealized_pnl
        FROM monitored_addresses a
        LEFT JOIN positions p ON p.address_id = a.id
        WHERE a.id = $1 AND a.active = TRUE
        GROUP BY a.id
      `,
      [id],
    ),
    pool.query<PositionRow>(
      `
        SELECT dex, coin, size, entry_price, position_value, unrealized_pnl,
          return_on_equity, liquidation_price, margin_used, leverage_type,
          leverage_value, leverage_raw_usd, max_leverage
        FROM positions
        WHERE address_id = $1
        ORDER BY dex ASC, ABS(position_value::numeric) DESC, coin ASC
      `,
      [id],
    ),
    pool.query<EventRow>(
      `
        SELECT id, dex, coin, kind, summary, before_position, after_position, detected_at
        FROM position_changes
        WHERE address_id = $1
        ORDER BY detected_at DESC
        LIMIT 100
      `,
      [id],
    ),
  ]);

  const address = addressResult.rows[0];
  if (!address) return null;

  return {
    ...mapAddress(address),
    positions: positionResult.rows.map(mapPosition),
    events: eventResult.rows.map((row) => ({
      id: row.id,
      dex: row.dex,
      coin: row.coin,
      kind: row.kind,
      summary: row.summary,
      before: normalizeHistoricalPosition(row.before_position),
      after: normalizeHistoricalPosition(row.after_position),
      detectedAt: row.detected_at.toISOString(),
    })),
  };
}

export async function findAddressId(address: string) {
  await ensureSchema();
  const result = await getDatabasePool().query<{ id: string }>(
    "SELECT id FROM monitored_addresses WHERE address = $1 AND active = TRUE",
    [address.toLowerCase()],
  );
  return result.rows[0]?.id ?? null;
}

export async function createMonitoredAddress(address: string, label: string | null) {
  const normalizedAddress = address.toLowerCase();
  const id = randomUUID();
  const configuredMax = Number(process.env.MAX_MONITORED_ADDRESSES || 40);
  const maxAddresses = Number.isFinite(configuredMax)
    ? Math.max(1, Math.floor(configuredMax))
    : 40;

  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(84519321)");
    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM monitored_addresses WHERE active = TRUE",
    );
    if (Number(countResult.rows[0]?.count || 0) >= maxAddresses) {
      throw new Error(`最多可监视 ${maxAddresses} 个地址。`);
    }

    await client.query(
      `
        INSERT INTO monitored_addresses (id, address, label)
        VALUES ($1, $2, $3)
      `,
      [id, normalizedAddress, label],
    );
  });

  return id;
}

export async function deleteMonitoredAddress(id: string) {
  await ensureSchema();
  const result = await getDatabasePool().query(
    "DELETE FROM monitored_addresses WHERE id = $1",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}
