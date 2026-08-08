import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchHyperliquidAccount,
  HyperliquidApiError,
  parseHyperliquidAccountPayload,
  parsePerpDexNames,
  resetHyperliquidClientStateForTests,
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
  assert.equal(snapshot.positions[0]?.dex, "");
  assert.equal(snapshot.positions[0]?.coin, "BTC");
  assert.equal(snapshot.positions[0]?.leverageValue, 10);
  assert.equal(snapshot.fetchedAt.toISOString(), "2026-08-07T00:00:00.000Z");
});

test("解析主 DEX 与 HIP-3 DEX 目录并去重", () => {
  assert.deepEqual(
    parsePerpDexNames([null, { name: "xyz" }, { name: "xyz" }, { name: "flx" }]),
    ["", "xyz", "flx"],
  );
  assert.throws(() => parsePerpDexNames([]), HyperliquidApiError);
  assert.throws(() => parsePerpDexNames([null, {}]), HyperliquidApiError);
});

test("读取并聚合主 DEX 与 HIP-3 仓位", async (t) => {
  const originalFetch = globalThis.fetch;
  resetHyperliquidClientStateForTests();
  t.after(() => {
    globalThis.fetch = originalFetch;
    resetHyperliquidClientStateForTests();
  });

  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.type === "perpDexs") {
      return new Response(JSON.stringify([null, { name: "xyz" }]), { status: 200 });
    }

    const payload = validPayload();
    if (body.dex === "") {
      payload.marginSummary.accountValue = "0.0000000000000001";
      payload.marginSummary.totalMarginUsed = "0";
      payload.withdrawable = "0";
      payload.assetPositions = [];
      payload.time = 1_786_060_800_001;
    } else {
      payload.marginSummary.accountValue = "2.5";
      payload.marginSummary.totalMarginUsed = "1.25";
      payload.withdrawable = "1.25";
      payload.assetPositions[0].position.coin = "xyz:SNDK";
      payload.time = 1_786_060_800_002;
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  const snapshot = await fetchHyperliquidAccount(
    "0x0000000000000000000000000000000000000001",
  );

  assert.equal(snapshot.accountValue, "2.5000000000000001");
  assert.equal(snapshot.totalMarginUsed, "1.25");
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0]?.dex, "xyz");
  assert.equal(snapshot.positions[0]?.coin, "xyz:SNDK");
  assert.deepEqual(snapshot.dexSnapshotTimes, {
    "": 1_786_060_800_001,
    xyz: 1_786_060_800_002,
  });
  await fetchHyperliquidAccount(
    "0x0000000000000000000000000000000000000002",
  );
  assert.equal(requests.filter((request) => request.type === "perpDexs").length, 1);
  assert.equal(requests.filter((request) => request.type === "clearinghouseState").length, 4);
});

test("任一 DEX 失败时整份账户快照会被拒绝", async (t) => {
  const originalFetch = globalThis.fetch;
  resetHyperliquidClientStateForTests();
  t.after(() => {
    globalThis.fetch = originalFetch;
    resetHyperliquidClientStateForTests();
  });

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.type === "perpDexs") {
      return new Response(JSON.stringify([null, { name: "xyz" }]), { status: 200 });
    }
    if (body.dex === "xyz") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify(validPayload()), { status: 200 });
  };

  await assert.rejects(
    fetchHyperliquidAccount("0x0000000000000000000000000000000000000001"),
    /xyz DEX 检查失败/,
  );
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
