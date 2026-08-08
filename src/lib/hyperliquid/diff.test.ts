import assert from "node:assert/strict";
import test from "node:test";
import { detectPositionChanges } from "@/lib/hyperliquid/diff";
import type { PositionSnapshot } from "@/lib/hyperliquid/types";

function position(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    dex: "",
    coin: "BTC",
    size: "1.0",
    entryPrice: "100000.0",
    positionValue: "100000",
    unrealizedPnl: "0",
    returnOnEquity: "0",
    liquidationPrice: "80000",
    marginUsed: "10000",
    leverageType: "cross",
    leverageValue: 10,
    leverageRawUsd: null,
    maxLeverage: 40,
    ...overrides,
  };
}

test("首次仓位与平仓分别识别为 opened 和 closed", () => {
  assert.equal(detectPositionChanges([], [position()])[0]?.kind, "opened");
  assert.equal(detectPositionChanges([position()], [])[0]?.kind, "closed");
});

test("按 signed size 识别加仓、减仓和反向", () => {
  assert.equal(
    detectPositionChanges([position({ size: "1" })], [position({ size: "2.0" })])[0]?.kind,
    "increased",
  );
  assert.equal(
    detectPositionChanges([position({ size: "2" })], [position({ size: "1.0" })])[0]?.kind,
    "reduced",
  );
  assert.equal(
    detectPositionChanges([position({ size: "1" })], [position({ size: "-1" })])[0]?.kind,
    "flipped",
  );
});

test("行情字段变化不会触发仓位变动", () => {
  const changes = detectPositionChanges(
    [position()],
    [
      position({
        positionValue: "102000",
        unrealizedPnl: "2000",
        returnOnEquity: "0.2",
        liquidationPrice: "80500",
        marginUsed: "10200",
      }),
    ],
  );
  assert.deepEqual(changes, []);
});

test("等价小数格式不会误报，杠杆变化会触发", () => {
  assert.deepEqual(
    detectPositionChanges([position({ size: "1.0" })], [position({ size: "1.000" })]),
    [],
  );
  assert.equal(
    detectPositionChanges([position()], [position({ leverageValue: 20 })])[0]?.kind,
    "leverage_changed",
  );
  assert.deepEqual(
    detectPositionChanges(
      [position({ leverageType: "isolated", leverageRawUsd: "-95" })],
      [position({ leverageType: "isolated", leverageRawUsd: "-95.01" })],
    ),
    [],
  );
});

test("极高精度的仓位数量仍按精确小数判断加减仓", () => {
  assert.equal(
    detectPositionChanges(
      [position({ size: "9007199254740992.0000000000000001" })],
      [position({ size: "9007199254740992.0000000000000002" })],
    )[0]?.kind,
    "increased",
  );
});

test("同名币在不同 DEX 中独立比较", () => {
  const changes = detectPositionChanges(
    [position({ dex: "", coin: "ETH" })],
    [position({ dex: "xyz", coin: "ETH" })],
  );

  assert.deepEqual(
    changes.map((change) => [change.dex, change.kind]),
    [
      ["", "closed"],
      ["xyz", "opened"],
    ],
  );
  assert.match(changes[1]?.summary ?? "", /XYZ/);
});
