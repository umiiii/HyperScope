import type {
  AccountSnapshot,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";

const DEFAULT_API_URL = "https://api.hyperliquid.xyz";
const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

export class HyperliquidApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decimalString(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !DECIMAL_PATTERN.test(value)
  ) {
    throw new HyperliquidApiError(`Hyperliquid 字段 ${field} 格式无效。`);
  }
  return value;
}

function nullableDecimalString(value: unknown, field: string) {
  if (value === null) return null;
  return decimalString(value, field);
}

function finiteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HyperliquidApiError(`Hyperliquid 字段 ${field} 格式无效。`);
  }
  return value;
}

function parsePosition(value: unknown, index: number): PositionSnapshot {
  if (!isRecord(value) || !isRecord(value.position)) {
    throw new HyperliquidApiError(`Hyperliquid 仓位 ${index} 格式无效。`);
  }
  const position = value.position;
  if (!isRecord(position.leverage)) {
    throw new HyperliquidApiError(`Hyperliquid 仓位 ${index} 缺少杠杆信息。`);
  }
  const leverage = position.leverage;
  if (
    typeof position.coin !== "string" ||
    position.coin.trim() === "" ||
    typeof leverage.type !== "string" ||
    leverage.type.trim() === ""
  ) {
    throw new HyperliquidApiError(`Hyperliquid 仓位 ${index} 标识格式无效。`);
  }

  return {
    coin: position.coin,
    size: decimalString(position.szi, `assetPositions[${index}].position.szi`),
    entryPrice: nullableDecimalString(
      position.entryPx,
      `assetPositions[${index}].position.entryPx`,
    ),
    positionValue: decimalString(
      position.positionValue,
      `assetPositions[${index}].position.positionValue`,
    ),
    unrealizedPnl: decimalString(
      position.unrealizedPnl,
      `assetPositions[${index}].position.unrealizedPnl`,
    ),
    returnOnEquity: decimalString(
      position.returnOnEquity,
      `assetPositions[${index}].position.returnOnEquity`,
    ),
    liquidationPrice: nullableDecimalString(
      position.liquidationPx,
      `assetPositions[${index}].position.liquidationPx`,
    ),
    marginUsed: decimalString(
      position.marginUsed,
      `assetPositions[${index}].position.marginUsed`,
    ),
    leverageType: leverage.type,
    leverageValue: finiteNumber(
      leverage.value,
      `assetPositions[${index}].position.leverage.value`,
    ),
    leverageRawUsd:
      leverage.rawUsd === undefined
        ? null
        : nullableDecimalString(
            leverage.rawUsd,
            `assetPositions[${index}].position.leverage.rawUsd`,
          ),
    maxLeverage:
      position.maxLeverage === undefined || position.maxLeverage === null
        ? null
        : finiteNumber(
            position.maxLeverage,
            `assetPositions[${index}].position.maxLeverage`,
          ),
  };
}

export function parseHyperliquidAccountPayload(
  payload: unknown,
): AccountSnapshot {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.assetPositions) ||
    !isRecord(payload.marginSummary)
  ) {
    throw new HyperliquidApiError("Hyperliquid 返回了无法识别的账户数据。");
  }

  const positions = payload.assetPositions
    .map((position, index) => parsePosition(position, index))
    .filter((position) => !/^-?(?:0+(?:\.0*)?|\.0+)$/.test(position.size));

  if (
    typeof payload.time !== "number" ||
    !Number.isSafeInteger(payload.time) ||
    payload.time <= 0
  ) {
    throw new HyperliquidApiError("Hyperliquid 字段 time 格式无效。");
  }
  const fetchedAt = new Date(payload.time);

  return {
    accountValue: decimalString(
      payload.marginSummary.accountValue,
      "marginSummary.accountValue",
    ),
    withdrawable: decimalString(payload.withdrawable, "withdrawable"),
    totalMarginUsed: decimalString(
      payload.marginSummary.totalMarginUsed,
      "marginSummary.totalMarginUsed",
    ),
    positions,
    fetchedAt,
  };
}

export async function fetchHyperliquidAccount(
  address: string,
): Promise<AccountSnapshot> {
  const baseUrl = (process.env.HYPERLIQUID_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "HyperScope/1.0 position-monitor",
    },
    body: JSON.stringify({
      type: "clearinghouseState",
      user: address,
      dex: "",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new HyperliquidApiError(
      `Hyperliquid 返回 ${response.status}${detail ? `：${detail}` : ""}`,
    );
  }

  const payload: unknown = await response.json();
  return parseHyperliquidAccountPayload(payload);
}
