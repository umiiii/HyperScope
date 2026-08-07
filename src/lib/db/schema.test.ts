import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { SCHEMA_STATEMENTS } from "@/lib/db/schema";

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
      address_id, coin, size, position_value, unrealized_pnl,
      return_on_equity, margin_used, leverage_type, leverage_value
    ) VALUES ('address-1', 'BTC', '1', '100000', '0', '0', '10000', 'cross', 10);

    INSERT INTO position_changes (
      id, address_id, batch_id, coin, kind, summary, fingerprint
    ) VALUES ('event-1', 'address-1', 'batch-1', 'BTC', 'opened', 'BTC 开仓', 'fingerprint-1');

    INSERT INTO notification_outbox (
      id, address_id, title, body, target_url, tag
    ) VALUES ('push-1', 'address-1', '仓位变动', 'BTC 开仓', '/addresses/address-1', 'tag-1');

    DELETE FROM monitored_addresses WHERE id = 'address-1';
  `);

  for (const table of ["positions", "position_changes", "notification_outbox"]) {
    const result = database.public.one(`SELECT COUNT(*)::int AS count FROM ${table}`);
    assert.equal(result.count, 0, `${table} 应已级联清理`);
  }
});
