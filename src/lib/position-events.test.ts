import assert from "node:assert/strict";
import test from "node:test";
import type { PositionEvent } from "@/lib/domain";
import { mergeAdjacentPositionEvents } from "@/lib/position-events";
import type { PositionSnapshot } from "@/lib/hyperliquid/types";

function position(size: string, overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    dex: "xyz",
    coin: "xyz:SHAZ",
    size,
    entryPrice: "1.0",
    positionValue: "1000",
    unrealizedPnl: "0",
    returnOnEquity: "0",
    liquidationPrice: null,
    marginUsed: "100",
    leverageType: "cross",
    leverageValue: 5,
    leverageRawUsd: null,
    maxLeverage: 20,
    ...overrides,
  };
}

function event(overrides: Partial<PositionEvent> = {}): PositionEvent {
  return {
    id: overrides.detectedAt ?? "event",
    dex: "xyz",
    coin: "xyz:SHAZ",
    kind: "increased",
    summary: "stored summary",
    before: null,
    after: null,
    detectedAt: "2026-08-18T04:00:00.000Z",
    ...overrides,
  };
}

/** Newest-first chain of 加仓 events, exactly how the API serves them. */
function increaseChain(sizes: string[]) {
  return sizes
    .slice(1)
    .map((size, index) =>
      event({
        id: `increase-${index}`,
        before: position(sizes[index]),
        after: position(size),
        detectedAt: new Date(Date.UTC(2026, 7, 18, 4, 2 * index)).toISOString(),
      }),
    )
    .reverse();
}

test("相邻的同币种加仓合并成一条，跨度取首末快照", () => {
  const merged = mergeAdjacentPositionEvents(increaseChain(["1423.76", "1598.97", "1774.19", "1949.4"]));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergedCount, 3);
  assert.equal(merged[0].summary, "XYZ · SHAZ 加仓 · 1,423.76 → 1,949.4");
  assert.equal(merged[0].before?.size, "1423.76");
  assert.equal(merged[0].after?.size, "1949.4");
  assert.equal(merged[0].firstDetectedAt, "2026-08-18T04:00:00.000Z");
  assert.equal(merged[0].detectedAt, "2026-08-18T04:04:00.000Z");
});

test("中间插入其它变动会切断合并", () => {
  const [newest, middle, oldest] = increaseChain(["1", "2", "3", "4"]);
  const merged = mergeAdjacentPositionEvents([
    newest,
    event({ id: "close", kind: "closed", before: position("2"), detectedAt: middle.detectedAt }),
    middle,
    oldest,
  ]);

  assert.deepEqual(
    merged.map((row) => [row.kind, row.mergedCount]),
    [
      ["increased", 1],
      ["closed", 1],
      ["increased", 2],
    ],
  );
});

test("不同币种、不同 DEX 或不同类型都不合并", () => {
  const merged = mergeAdjacentPositionEvents([
    event({ id: "a", before: position("1"), after: position("2") }),
    event({ id: "b", coin: "xyz:BTC", before: position("1"), after: position("2") }),
    event({ id: "c", dex: "", before: position("1"), after: position("2") }),
    event({ id: "d", kind: "reduced", before: position("2"), after: position("1") }),
  ]);

  assert.equal(merged.length, 4);
  assert.ok(merged.every((row) => row.mergedCount === 1));
});

test("开仓、平仓、反向和监视事件保持独立", () => {
  const kinds: PositionEvent["kind"][] = ["opened", "closed", "flipped", "monitor_scope_updated"];
  for (const kind of kinds) {
    const merged = mergeAdjacentPositionEvents([
      event({ id: `${kind}-1`, kind, before: position("1"), after: position("2") }),
      event({ id: `${kind}-2`, kind, before: position("1"), after: position("2") }),
    ]);
    assert.equal(merged.length, 2, `${kind} 不应合并`);
  }
});

test("合并杠杆调整并沿用变动类型的文案", () => {
  const merged = mergeAdjacentPositionEvents([
    event({
      id: "lev-2",
      kind: "leverage_changed",
      before: position("1", { leverageValue: 10 }),
      after: position("1", { leverageValue: 20 }),
      detectedAt: "2026-08-18T04:02:00.000Z",
    }),
    event({
      id: "lev-1",
      kind: "leverage_changed",
      before: position("1", { leverageValue: 5 }),
      after: position("1", { leverageValue: 10 }),
      detectedAt: "2026-08-18T04:00:00.000Z",
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].summary, "XYZ · SHAZ 杠杆调整 · 5x → 20x");
});

test("缺少快照的历史事件回退到已存摘要", () => {
  const merged = mergeAdjacentPositionEvents([
    event({ id: "legacy-2", summary: "旧摘要 2", detectedAt: "2026-08-18T04:02:00.000Z" }),
    event({ id: "legacy-1", summary: "旧摘要 1", detectedAt: "2026-08-18T04:00:00.000Z" }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergedCount, 2);
  assert.equal(merged[0].summary, "旧摘要 2");
});

test("空列表和单条事件原样返回", () => {
  assert.deepEqual(mergeAdjacentPositionEvents([]), []);
  const single = mergeAdjacentPositionEvents([event({ id: "solo", summary: "只有一条" })]);
  assert.equal(single.length, 1);
  assert.equal(single[0].mergedCount, 1);
  assert.equal(single[0].summary, "只有一条");
  assert.equal(single[0].firstDetectedAt, single[0].detectedAt);
});
