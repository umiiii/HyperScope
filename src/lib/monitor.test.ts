import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { SCHEMA_STATEMENTS } from "@/lib/db/schema";
import { monitorAddress } from "@/lib/monitor";

const ADDRESS = "0x0000000000000000000000000000000000000001";

function accountPayload(time: number, size: string | null) {
  return {
    marginSummary: {
      accountValue: size ? "11000" : "10000",
      totalMarginUsed: size ? "1000" : "0",
      totalNtlPos: size ? "10000" : "0",
      totalRawUsd: size ? "10000" : "0",
    },
    crossMarginSummary: {
      accountValue: size ? "11000" : "10000",
      totalMarginUsed: size ? "1000" : "0",
      totalNtlPos: size ? "10000" : "0",
      totalRawUsd: size ? "10000" : "0",
    },
    crossMaintenanceMarginUsed: "0",
    withdrawable: size ? "10000" : "10000",
    assetPositions: size
      ? [
          {
            type: "oneWay",
            position: {
              coin: "BTC",
              szi: size,
              entryPx: "100000",
              positionValue: "10000",
              unrealizedPnl: "0",
              returnOnEquity: "0",
              liquidationPx: "80000",
              marginUsed: "1000",
              leverage: { type: "cross", value: 10 },
              maxLeverage: 40,
            },
          },
        ]
      : [],
    time,
  };
}

async function setupDatabase() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  for (const statement of SCHEMA_STATEMENTS) database.public.none(statement);
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();

  process.env.DATABASE_URL = "postgresql://in-process-test";
  globalThis.hyperScopeDatabasePool = pool as unknown as Pool;
  globalThis.hyperScopeSchemaPromise = Promise.resolve();
  await pool.query(
    "INSERT INTO monitored_addresses (id, address) VALUES ('address-1', $1)",
    [ADDRESS],
  );

  return pool;
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitForLength<T>(values: T[], length: number) {
  for (let attempt = 0; attempt < 100 && values.length < length; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(values.length, length, "等待中的 Hyperliquid 请求数量不符");
}

test("首次请求失败后，首次成功仍只建立基线", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  const failed = await monitorAddress("address-1");
  assert.equal(failed.success, false);

  const afterFailure = await pool.query(
    "SELECT last_checked_at FROM monitored_addresses WHERE id = 'address-1'",
  );
  assert.equal(afterFailure.rows[0]?.last_checked_at, null);

  globalThis.fetch = async () => jsonResponse(accountPayload(1_786_060_800_000, "0.1"));
  const baseline = await monitorAddress("address-1");
  assert.equal(baseline.success, true);
  assert.equal(baseline.initialSnapshot, true);
  assert.deepEqual(baseline.changes, []);

  const positions = await pool.query("SELECT 1 FROM positions");
  const notifications = await pool.query("SELECT 1 FROM notification_outbox");
  assert.equal(positions.rowCount, 1);
  assert.equal(notifications.rowCount, 0);
});

test("较旧的并发响应不会覆盖较新的仓位快照", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  globalThis.fetch = async () => jsonResponse(accountPayload(1_786_060_800_000, null));
  await monitorAddress("address-1");

  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      pending.push(resolve);
    });

  const olderRequest = monitorAddress("address-1");
  await waitForLength(pending, 1);
  const newerRequest = monitorAddress("address-1");
  await waitForLength(pending, 2);

  pending[1](jsonResponse(accountPayload(1_786_060_802_000, "0.1")));
  const newerResult = await newerRequest;
  assert.equal(newerResult.changes[0]?.kind, "opened");

  pending[0](jsonResponse(accountPayload(1_786_060_801_000, null)));
  const olderResult = await olderRequest;
  assert.deepEqual(olderResult.changes, []);

  const positions = await pool.query("SELECT 1 FROM positions");
  const opened = await pool.query("SELECT 1 FROM position_changes WHERE kind = 'opened'");
  const closed = await pool.query("SELECT 1 FROM position_changes WHERE kind = 'closed'");
  assert.equal(positions.rowCount, 1);
  assert.equal(opened.rowCount, 1);
  assert.equal(closed.rowCount, 0);
});
