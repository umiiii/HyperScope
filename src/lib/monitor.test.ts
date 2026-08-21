import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { SCHEMA_STATEMENTS } from "@/lib/db/schema";
import { resetHyperliquidClientStateForTests } from "@/lib/hyperliquid/client";
import { monitorAddress } from "@/lib/monitor";

const ADDRESS = "0x0000000000000000000000000000000000000001";

type PayloadPosition = { coin: string; size: string };

function accountPayload(time: number, size: string | null, coin = "BTC") {
  return accountPayloadWith(time, size ? [{ coin, size }] : []);
}

function accountPayloadWith(time: number, positions: PayloadPosition[]) {
  const funded = positions.length > 0;
  const summary = {
    accountValue: funded ? "11000" : "10000",
    totalMarginUsed: funded ? "1000" : "0",
    totalNtlPos: funded ? "10000" : "0",
    totalRawUsd: funded ? "10000" : "0",
  };

  return {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: "0",
    withdrawable: "10000",
    assetPositions: positions.map(({ coin, size }) => ({
      type: "oneWay",
      position: {
        coin,
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
    })),
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
  for (let attempt = 0; attempt < 150 && values.length < length; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(values.length, length, "等待中的 Hyperliquid 请求数量不符");
}

function requestBody(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function mainDexFetch(payload: unknown) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = requestBody(init);
    return body.type === "perpDexs"
      ? jsonResponse([null])
      : jsonResponse(payload);
  };
}

test("首次请求失败后，首次成功仍只建立基线", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
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

  globalThis.fetch = mainDexFetch(accountPayload(1_786_060_800_000, "0.1"));
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
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  globalThis.fetch = mainDexFetch(accountPayload(1_786_060_800_000, null));
  await monitorAddress("address-1");

  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return Promise.resolve(jsonResponse([null]));
    return new Promise<Response>((resolve) => {
      pending.push(resolve);
    });
  };

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

test("已有地址首次发现 HIP-3 仓位时静默建立该 DEX 基线", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  await pool.query(
    `
      UPDATE monitored_addresses
      SET last_checked_at = $1, status = 'healthy'
      WHERE id = 'address-1'
    `,
    [new Date(1_786_060_800_000)],
  );
  await pool.query(
    `
      INSERT INTO monitored_address_dex_states (address_id, dex, last_snapshot_at)
      VALUES ('address-1', '', $1)
    `,
    [new Date(1_786_060_800_000)],
  );

  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") {
      return jsonResponse([null, { name: "xyz" }]);
    }
    return body.dex === "xyz"
      ? jsonResponse(accountPayload(1_786_060_802_000, "1", "xyz:SNDK"))
      : jsonResponse(accountPayload(1_786_060_801_000, null));
  };

  const result = await monitorAddress("address-1");
  assert.equal(result.success, true);
  assert.equal(result.initialSnapshot, false);
  assert.deepEqual(result.changes, []);

  const positions = await pool.query("SELECT dex, coin FROM positions");
  const opened = await pool.query("SELECT 1 FROM position_changes WHERE kind = 'opened'");
  const scope = await pool.query(
    "SELECT 1 FROM position_changes WHERE kind = 'monitor_scope_updated'",
  );
  const notifications = await pool.query("SELECT 1 FROM notification_outbox");
  assert.deepEqual(positions.rows, [{ dex: "xyz", coin: "xyz:SNDK" }]);
  assert.equal(opened.rowCount, 0);
  assert.equal(scope.rowCount, 1);
  assert.equal(notifications.rowCount, 0);
});

test("新 DEX 空仓基线建立后，后续开仓会正常通知", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  const state = { xyzSize: null as string | null, time: 1_786_060_800_000 };
  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return jsonResponse([null, { name: "xyz" }]);
    const time = state.time + (body.dex === "xyz" ? 1 : 0);
    return body.dex === "xyz"
      ? jsonResponse(accountPayload(time, state.xyzSize, "xyz:SNDK"))
      : jsonResponse(accountPayload(time, null));
  };

  const baseline = await monitorAddress("address-1");
  assert.equal(baseline.initialSnapshot, true);
  assert.deepEqual(baseline.changes, []);

  state.xyzSize = "1";
  state.time += 2_000;
  const changed = await monitorAddress("address-1");
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0]?.dex, "xyz");
  assert.equal(changed.changes[0]?.kind, "opened");

  const notifications = await pool.query("SELECT 1 FROM notification_outbox");
  assert.equal(notifications.rowCount, 1);
});

test("单个 HIP-3 请求失败会保留旧仓位且不误报平仓", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return jsonResponse([null, { name: "xyz" }]);
    return body.dex === "xyz"
      ? jsonResponse(accountPayload(1_786_060_800_001, "1", "xyz:SNDK"))
      : jsonResponse(accountPayload(1_786_060_800_000, null));
  };
  await monitorAddress("address-1");

  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.dex === "xyz") return new Response("temporarily unavailable", { status: 503 });
    return jsonResponse(accountPayload(1_786_060_802_000, null));
  };
  const failed = await monitorAddress("address-1");
  assert.equal(failed.success, false);

  const positions = await pool.query("SELECT dex, coin FROM positions");
  const closed = await pool.query("SELECT 1 FROM position_changes WHERE kind = 'closed'");
  const notifications = await pool.query("SELECT 1 FROM notification_outbox");
  assert.deepEqual(positions.rows, [{ dex: "xyz", coin: "xyz:SNDK" }]);
  assert.equal(closed.rowCount, 0);
  assert.equal(notifications.rowCount, 0);
});

test("事务外的旧 DEX 目录不会覆盖并发建立的新 DEX 聚合快照", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  await pool.query(
    `
      UPDATE monitored_addresses
      SET last_checked_at = $1, account_value = '777', status = 'healthy'
      WHERE id = 'address-1';
      INSERT INTO monitored_address_dex_states (address_id, dex, last_snapshot_at)
      VALUES ('address-1', '', $1)
    `,
    [new Date(1_786_060_800_000)],
  );

  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return Promise.resolve(jsonResponse([null]));
    return new Promise<Response>((resolve) => pending.push(resolve));
  };

  const staleCatalogRequest = monitorAddress("address-1");
  await waitForLength(pending, 1);
  await pool.query(
    `
      INSERT INTO monitored_address_dex_states (address_id, dex, last_snapshot_at)
      VALUES ('address-1', 'xyz', $1);
      INSERT INTO positions (
        address_id, dex, coin, size, position_value, unrealized_pnl,
        return_on_equity, margin_used, leverage_type, leverage_value
      ) VALUES ('address-1', 'xyz', 'xyz:SNDK', '1', '1000', '0', '0', '500', 'isolated', 2)
    `,
    [new Date(1_786_060_800_500)],
  );
  pending[0](jsonResponse(accountPayload(1_786_060_801_000, null)));
  await staleCatalogRequest;

  const address = await pool.query(
    "SELECT account_value FROM monitored_addresses WHERE id = 'address-1'",
  );
  const positions = await pool.query("SELECT dex, coin FROM positions");
  assert.equal(address.rows[0]?.account_value, "777");
  assert.deepEqual(positions.rows, [{ dex: "xyz", coin: "xyz:SNDK" }]);
});

test("同一地址同一 ticker 同方向在冷却窗口内只推送一次", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  const state = { size: null as string | null, time: 1_786_060_800_000 };
  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return jsonResponse([null]);
    return jsonResponse(accountPayload(state.time, state.size));
  };

  await monitorAddress("address-1");

  state.size = "0.1";
  state.time += 1_000;
  const opened = await monitorAddress("address-1");
  assert.equal(opened.changes[0]?.kind, "opened");
  assert.equal(opened.notified.length, 1);

  state.size = "0.2";
  state.time += 1_000;
  const increased = await monitorAddress("address-1");
  assert.equal(increased.changes[0]?.kind, "increased");
  assert.deepEqual(increased.notified, []);

  const recorded = await pool.query(
    "SELECT 1 FROM position_changes WHERE kind IN ('opened', 'increased')",
  );
  const muted = await pool.query("SELECT 1 FROM notification_outbox");
  assert.equal(recorded.rowCount, 2, "两次变动都应留在仓位变动记录中");
  assert.equal(muted.rowCount, 1, "冷却窗口内只应产生一条推送");

  await pool.query("UPDATE notification_cooldowns SET last_pushed_at = $1", [
    new Date(Date.now() - 11 * 60_000),
  ]);
  state.size = "0.15";
  state.time += 1_000;
  const reduced = await monitorAddress("address-1");
  assert.equal(reduced.changes[0]?.kind, "reduced");
  assert.equal(reduced.notified.length, 1);

  const afterWindow = await pool.query("SELECT 1 FROM notification_outbox");
  assert.equal(afterWindow.rowCount, 2, "冷却过期后应重新推送");
});

test("冷却按方向与 ticker 分别计算", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  resetHyperliquidClientStateForTests();
  const pool = await setupDatabase();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
    resetHyperliquidClientStateForTests();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
  });

  const state = { positions: [] as PayloadPosition[], time: 1_786_060_800_000 };
  globalThis.fetch = async (_input, init) => {
    const body = requestBody(init);
    if (body.type === "perpDexs") return jsonResponse([null]);
    return jsonResponse(accountPayloadWith(state.time, state.positions));
  };

  await monitorAddress("address-1");

  state.positions = [{ coin: "BTC", size: "0.1" }];
  state.time += 1_000;
  const long = await monitorAddress("address-1");
  assert.equal(long.notified.length, 1);

  state.positions = [
    { coin: "BTC", size: "-0.1" },
    { coin: "ETH", size: "1" },
  ];
  state.time += 1_000;
  const flipped = await monitorAddress("address-1");
  assert.deepEqual(
    flipped.changes.map((change) => change.kind).sort(),
    ["flipped", "opened"],
    "反向和新 ticker 都应被检测到",
  );
  assert.equal(flipped.notified.length, 2, "空仓与另一个 ticker 都不受多仓冷却影响");

  state.positions = [
    { coin: "BTC", size: "-0.2" },
    { coin: "ETH", size: "2" },
  ];
  state.time += 1_000;
  const scaled = await monitorAddress("address-1");
  assert.equal(scaled.changes.length, 2);
  assert.deepEqual(scaled.notified, [], "同 ticker 同方向的后续加仓应被静音");

  const cooldowns = await pool.query(
    "SELECT coin, direction FROM notification_cooldowns ORDER BY coin, direction",
  );
  const notifications = await pool.query("SELECT 1 FROM notification_outbox");
  assert.deepEqual(cooldowns.rows, [
    { coin: "BTC", direction: "long" },
    { coin: "BTC", direction: "short" },
    { coin: "ETH", direction: "long" },
  ]);
  assert.equal(notifications.rowCount, 2);
});
