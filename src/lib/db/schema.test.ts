import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ADDITIVE_SCHEMA_MIGRATIONS,
  SCHEMA_STATEMENTS,
} from "@/lib/db/schema";

function createTestDatabase() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  for (const statement of SCHEMA_STATEMENTS) {
    database.public.none(statement);
  }
  return database;
}

test("数据库 schema 可完整建立且地址唯一", () => {
  const database = createTestDatabase();
  database.public.none(`
    INSERT INTO monitored_addresses (id, address)
    VALUES ('address-1', '0x0000000000000000000000000000000000000001')
  `);

  assert.throws(() =>
    database.public.none(`
      INSERT INTO monitored_addresses (id, address)
      VALUES ('address-2', '0x0000000000000000000000000000000000000001')
    `),
  );
});

test("删除监视地址会级联清理仓位、事件和待发送通知", () => {
  const database = createTestDatabase();
  database.public.none(`
    INSERT INTO monitored_addresses (id, address)
    VALUES ('address-1', '0x0000000000000000000000000000000000000001');

    INSERT INTO positions (
      address_id, dex, coin, size, position_value, unrealized_pnl,
      return_on_equity, margin_used, leverage_type, leverage_value
    ) VALUES
      ('address-1', '', 'BTC', '1', '100000', '0', '0', '10000', 'cross', 10),
      ('address-1', 'xyz', 'BTC', '2', '200000', '0', '0', '20000', 'cross', 10);

    INSERT INTO monitored_address_dex_states (address_id, dex, last_snapshot_at)
    VALUES ('address-1', '', NOW());

    INSERT INTO position_changes (
      id, address_id, batch_id, coin, kind, summary, fingerprint
    ) VALUES ('event-1', 'address-1', 'batch-1', 'BTC', 'opened', 'BTC 开仓', 'fingerprint-1');

    INSERT INTO notification_outbox (
      id, address_id, title, body, target_url, tag
    ) VALUES ('push-1', 'address-1', '仓位变动', 'BTC 开仓', '/addresses/address-1', 'tag-1');

    INSERT INTO notification_cooldowns (address_id, coin, direction, last_pushed_at)
    VALUES ('address-1', 'BTC', 'long', NOW());

    DELETE FROM monitored_addresses WHERE id = 'address-1';
  `);

  for (const table of [
    "positions",
    "monitored_address_dex_states",
    "position_changes",
    "notification_outbox",
    "notification_cooldowns",
  ]) {
    const result = database.public.one(`SELECT COUNT(*)::int AS count FROM ${table}`);
    assert.equal(result.count, 0, `${table} 应已级联清理`);
  }
});

test("旧版主 DEX schema 会回填水位并迁移为 DEX 复合主键", () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.none(`
    CREATE TABLE monitored_addresses (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ
    );
    CREATE TABLE positions (
      address_id TEXT NOT NULL REFERENCES monitored_addresses(id) ON DELETE CASCADE,
      coin TEXT NOT NULL,
      size TEXT NOT NULL,
      entry_price TEXT,
      position_value TEXT NOT NULL,
      unrealized_pnl TEXT NOT NULL,
      return_on_equity TEXT NOT NULL,
      liquidation_price TEXT,
      margin_used TEXT NOT NULL,
      leverage_type TEXT NOT NULL,
      leverage_value INTEGER NOT NULL,
      leverage_raw_usd TEXT,
      max_leverage INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (address_id, coin)
    );
    CREATE TABLE position_changes (
      id TEXT PRIMARY KEY,
      address_id TEXT NOT NULL REFERENCES monitored_addresses(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      coin TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_position JSONB,
      after_position JSONB,
      fingerprint TEXT NOT NULL UNIQUE,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE push_subscriptions (
      endpoint_hash TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expiration_time BIGINT,
      user_agent TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  for (const statement of SCHEMA_STATEMENTS.filter(
    (statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS monitored_address_dex_states") ||
      statement.includes("CREATE TABLE IF NOT EXISTS schema_migrations") ||
      statement.includes("push_test_limits"),
  )) {
    database.public.none(statement);
  }
  database.public.none(`
    INSERT INTO monitored_addresses (id, address, last_checked_at)
    VALUES ('legacy', '0x0000000000000000000000000000000000000001', '2026-08-08T00:00:00Z');
    INSERT INTO positions (
      address_id, coin, size, position_value, unrealized_pnl,
      return_on_equity, margin_used, leverage_type, leverage_value
    ) VALUES ('legacy', 'BTC', '1', '100000', '0', '0', '10000', 'cross', 10);
    INSERT INTO position_changes (
      id, address_id, batch_id, coin, kind, summary, fingerprint
    ) VALUES ('legacy-event', 'legacy', 'batch', 'BTC', 'opened', 'BTC 开仓', 'legacy-fingerprint');
  `);
  for (const statement of ADDITIVE_SCHEMA_MIGRATIONS) database.public.none(statement);
  database.public.none(`
    ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey;
    ALTER TABLE positions ADD CONSTRAINT positions_pkey PRIMARY KEY (address_id, dex, coin);
    INSERT INTO positions (
      address_id, dex, coin, size, position_value, unrealized_pnl,
      return_on_equity, margin_used, leverage_type, leverage_value
    ) VALUES ('legacy', 'xyz', 'BTC', '2', '200000', '0', '0', '20000', 'cross', 10);
  `);

  assert.equal(
    database.public.one(
      "SELECT COUNT(*)::int AS count FROM monitored_address_dex_states WHERE address_id = 'legacy' AND dex = ''",
    ).count,
    1,
  );
  assert.equal(
    database.public.one("SELECT COUNT(*)::int AS count FROM positions WHERE coin = 'BTC'").count,
    2,
  );
  assert.equal(
    database.public.one("SELECT dex FROM position_changes WHERE id = 'legacy-event'").dex,
    "",
  );
  database.public.none(`
    INSERT INTO push_test_limits (endpoint_hash, last_attempt_at)
    VALUES ('legacy-test-limit', NOW())
  `);
  assert.equal(
    database.public.one("SELECT COUNT(*)::int AS count FROM push_test_limits").count,
    1,
  );
});
