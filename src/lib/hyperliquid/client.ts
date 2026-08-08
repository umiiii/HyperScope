import type {
  AccountSnapshot,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";

const DEFAULT_API_URL = "https://api.hyperliquid.xyz";
const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const DEX_CATALOG_TTL_MS = 10 * 60_000;
const REQUEST_START_INTERVAL_MS = 125;
const MAX_CONCURRENT_REQUESTS = 8;

type DexCatalogCache = {
  baseUrl: string;
  dexes: string[];
  expiresAt: number;
};

let dexCatalogCache: DexCatalogCache | null = null;
const dexCatalogRequests = new Map<string, Promise<string[]>>();
let activeRequests = 0;
let nextRequestStartAt = 0;
let pacingTail: Promise<void> = Promise.resolve();
const concurrencyWaiters: Array<() => void> = [];

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

function parsePosition(value: unknown, index: number, dex: string): PositionSnapshot {
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
    dex,
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
  dex = "",
): AccountSnapshot {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.assetPositions) ||
    !isRecord(payload.marginSummary)
  ) {
    throw new HyperliquidApiError("Hyperliquid 返回了无法识别的账户数据。");
  }

  const positions = payload.assetPositions
    .map((position, index) => parsePosition(position, index, dex))
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
    dexSnapshotTimes: { [dex]: payload.time },
  };
}

export function parsePerpDexNames(payload: unknown) {
  if (!Array.isArray(payload) || payload.length === 0 || payload[0] !== null) {
    throw new HyperliquidApiError("Hyperliquid 返回了无法识别的永续 DEX 列表。");
  }

  const dexes = [""];
  const seen = new Set(dexes);
  for (let index = 1; index < payload.length; index += 1) {
    const value = payload[index];
    if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "") {
      throw new HyperliquidApiError(`Hyperliquid 永续 DEX ${index} 格式无效。`);
    }
    const name = value.name.trim();
    if (!seen.has(name)) {
      seen.add(name);
      dexes.push(name);
    }
  }
  return dexes;
}

function decimalParts(value: string) {
  decimalString(value, "aggregate");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  return { negative, integer: integer || "0", fraction };
}

function sumDecimals(values: string[]) {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.fraction.length));
  const total = parts.reduce((sum, part) => {
    const digits = `${part.integer}${part.fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
    const amount = BigInt(digits || "0");
    return sum + (part.negative ? -amount : amount);
  }, BigInt(0));

  const negative = total < BigInt(0);
  const absolute = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const integer = scale === 0 ? absolute : absolute.slice(0, -scale);
  const fraction = scale === 0 ? "" : absolute.slice(-scale).replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

export function aggregateAccountSnapshots(snapshots: AccountSnapshot[]): AccountSnapshot {
  if (snapshots.length === 0) {
    throw new HyperliquidApiError("Hyperliquid 没有返回任何永续 DEX 快照。");
  }

  const dexSnapshotTimes: Record<string, number> = {};
  const positions: PositionSnapshot[] = [];
  const positionKeys = new Set<string>();

  for (const snapshot of snapshots) {
    for (const [dex, time] of Object.entries(snapshot.dexSnapshotTimes)) {
      if (dex in dexSnapshotTimes) {
        throw new HyperliquidApiError(`Hyperliquid 返回了重复的 DEX 快照：${dex || "main"}。`);
      }
      dexSnapshotTimes[dex] = time;
    }
    for (const position of snapshot.positions) {
      const key = `${position.dex}\u0000${position.coin}`;
      if (positionKeys.has(key)) {
        throw new HyperliquidApiError(`Hyperliquid 返回了重复仓位：${position.coin}。`);
      }
      positionKeys.add(key);
      positions.push(position);
    }
  }

  return {
    accountValue: sumDecimals(snapshots.map((snapshot) => snapshot.accountValue)),
    withdrawable: sumDecimals(snapshots.map((snapshot) => snapshot.withdrawable)),
    totalMarginUsed: sumDecimals(snapshots.map((snapshot) => snapshot.totalMarginUsed)),
    positions,
    fetchedAt: new Date(Math.max(...snapshots.map((snapshot) => snapshot.fetchedAt.getTime()))),
    dexSnapshotTimes,
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireRequestSlot() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => concurrencyWaiters.push(resolve));
    return;
  }
  activeRequests += 1;
}

function releaseRequestSlot() {
  const next = concurrencyWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeRequests -= 1;
}

async function paceRequestStart() {
  const previous = pacingTail;
  let release!: () => void;
  pacingTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const now = Date.now();
    if (nextRequestStartAt > now) await delay(nextRequestStartAt - now);
    nextRequestStartAt = Date.now() + REQUEST_START_INTERVAL_MS;
  } finally {
    release();
  }
}

async function postInfo(baseUrl: string, body: Record<string, unknown>) {
  await acquireRequestSlot();
  try {
    await paceRequestStart();
    const response = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HyperScope/1.0 position-monitor",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new HyperliquidApiError(
        `Hyperliquid 返回 ${response.status}${detail ? `：${detail}` : ""}`,
      );
    }
    return (await response.json()) as unknown;
  } finally {
    releaseRequestSlot();
  }
}

async function fetchPerpDexNames(baseUrl: string) {
  const now = Date.now();
  if (
    dexCatalogCache?.baseUrl === baseUrl &&
    dexCatalogCache.expiresAt > now
  ) {
    return dexCatalogCache.dexes;
  }
  const currentRequest = dexCatalogRequests.get(baseUrl);
  if (currentRequest) return currentRequest;

  const request = (async () => {
    try {
      const dexes = parsePerpDexNames(await postInfo(baseUrl, { type: "perpDexs" }));
      dexCatalogCache = {
        baseUrl,
        dexes,
        expiresAt: Date.now() + DEX_CATALOG_TTL_MS,
      };
      return dexes;
    } catch (error) {
      if (dexCatalogCache?.baseUrl === baseUrl) return dexCatalogCache.dexes;
      throw error;
    } finally {
      dexCatalogRequests.delete(baseUrl);
    }
  })();
  dexCatalogRequests.set(baseUrl, request);
  return request;
}

export function resetHyperliquidClientStateForTests() {
  dexCatalogCache = null;
  dexCatalogRequests.clear();
  activeRequests = 0;
  nextRequestStartAt = 0;
  pacingTail = Promise.resolve();
  concurrencyWaiters.splice(0);
}

export async function fetchHyperliquidAccount(
  address: string,
  previouslyKnownDexes: string[] = [],
): Promise<AccountSnapshot> {
  const baseUrl = (process.env.HYPERLIQUID_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  const discoveredDexes = await fetchPerpDexNames(baseUrl);
  const dexes = [...new Set([...discoveredDexes, ...previouslyKnownDexes])]
    .filter((dex): dex is string => typeof dex === "string")
    .sort((left, right) => {
      if (left === "") return -1;
      if (right === "") return 1;
      return left.localeCompare(right);
    });

  const snapshots = await Promise.all(
    dexes.map(async (dex) => {
      try {
        const payload = await postInfo(baseUrl, {
          type: "clearinghouseState",
          user: address,
          dex,
        });
        return parseHyperliquidAccountPayload(payload, dex);
      } catch (error) {
        const label = dex || "main";
        const message = error instanceof Error ? error.message : String(error);
        throw new HyperliquidApiError(`${label} DEX 检查失败：${message}`);
      }
    }),
  );
  return aggregateAccountSnapshots(snapshots);
}
