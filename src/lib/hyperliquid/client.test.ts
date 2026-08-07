import assert from "node:assert/strict";
import test from "node:test";
import {
  HyperliquidApiError,
  parseHyperliquidAccountPayload,
} from "@/lib/hyperliquid/client";

function validPayload() {
  return {
    marginSummary: {
      accountValue: "12500.25",
      totalMarginUsed: "1000",
      totalNtlPos: "10000",
      totalRawUsd: "0",
    },
    withdrawable: "11500.25",
    time: 1_786_060_800_000,
    assetPositions: [
      {
        type: "oneWay",
        position: {
          coin: "BTC",
          szi: "0.1",
          entryPx: "100000",
          positionValue: "10100",
          unrealizedPnl: "100",
          returnOnEquity: "0.1",
          liquidationPx: "80000",
          marginUsed: "1000",
          leverage: { type: "cross", value: 10 },
          maxLeverage: 40,
        },
      },
    ],
  };
}

test("解析官方 clearinghouseState 仓位结构", () => {
  const snapshot = parseHyperliquidAccountPayload(validPayload());

  assert.equal(snapshot.accountValue, "12500.25");
  assert.equal(snapshot.positions[0]?.coin, "BTC");
  assert.equal(snapshot.positions[0]?.leverageValue, 10);
  assert.equal(snapshot.fetchedAt.toISOString(), "2026-08-07T00:00:00.000Z");
});

test("异常响应结构会整体拒绝，避免误报平仓", () => {
  const payload = validPayload();
  payload.assetPositions[0].position.szi = "not-a-number";

  assert.throws(
    () => parseHyperliquidAccountPayload(payload),
    HyperliquidApiError,
  );
  assert.throws(
    () => parseHyperliquidAccountPayload({ assetPositions: [] }),
    HyperliquidApiError,
  );

  const hexadecimalZero = validPayload();
  hexadecimalZero.assetPositions[0].position.szi = "0x0";
  assert.throws(
    () => parseHyperliquidAccountPayload(hexadecimalZero),
    HyperliquidApiError,
  );
});
