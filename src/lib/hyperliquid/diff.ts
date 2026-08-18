import type {
  PositionChange,
  PositionChangeKind,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";

export type PositionChangeDescriptor = Omit<PositionChange, "summary">;

function normalizeDecimal(value: string | null) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return "0";

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function decimalEquals(left: string | null, right: string | null) {
  return normalizeDecimal(left) === normalizeDecimal(right);
}

function decimalSign(value: string) {
  const normalized = normalizeDecimal(value) ?? "0";
  if (normalized === "0") return 0;
  return normalized.startsWith("-") ? -1 : 1;
}

function compareAbsoluteDecimals(left: string, right: string) {
  const normalizedLeft = (normalizeDecimal(left) ?? "0").replace("-", "");
  const normalizedRight = (normalizeDecimal(right) ?? "0").replace("-", "");
  const [leftInteger, leftFraction = ""] = normalizedLeft.split(".");
  const [rightInteger, rightFraction = ""] = normalizedRight.split(".");

  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length > rightInteger.length ? 1 : -1;
  }
  if (leftInteger !== rightInteger) {
    return leftInteger > rightInteger ? 1 : -1;
  }

  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const comparableLeft = leftFraction.padEnd(fractionLength, "0");
  const comparableRight = rightFraction.padEnd(fractionLength, "0");
  if (comparableLeft === comparableRight) return 0;
  return comparableLeft > comparableRight ? 1 : -1;
}

function direction(size: string) {
  return decimalSign(size) >= 0 ? "多仓" : "空仓";
}

function absoluteSize(size: string) {
  const normalized = (normalizeDecimal(size) ?? "0").replace("-", "");
  const [integer, fraction = ""] = normalized.split(".");
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const visibleFraction = fraction.slice(0, 8);
  return visibleFraction ? `${groupedInteger}.${visibleFraction}` : groupedInteger;
}

function positionKey(position: PositionSnapshot) {
  return `${position.dex}\u0000${position.coin}`;
}

function displayPosition(dex: string, coin: string) {
  if (!dex) return coin;
  const prefix = `${dex}:`;
  const symbol = coin.startsWith(prefix) ? coin.slice(prefix.length) : coin;
  return `${dex.toUpperCase()} · ${symbol}`;
}

/** Renders the human-readable summary for a change, or `null` when the
 *  snapshots the change kind needs are missing. */
export function describePositionChange(change: PositionChangeDescriptor): string | null {
  const { before, after } = change;
  const label = displayPosition(change.dex, change.coin);

  if (change.kind === "opened") {
    return after ? `${label} 开仓 · ${direction(after.size)} ${absoluteSize(after.size)}` : null;
  }

  if (change.kind === "closed") {
    return before ? `${label} 平仓 · 原${direction(before.size)} ${absoluteSize(before.size)}` : null;
  }

  if (!before || !after) return null;

  switch (change.kind) {
    case "flipped":
      return `${label} 反向 · ${direction(before.size)} → ${direction(after.size)}`;
    case "increased":
    case "reduced":
      return `${label} ${change.kind === "increased" ? "加仓" : "减仓"} · ${absoluteSize(before.size)} → ${absoluteSize(after.size)}`;
    case "leverage_changed":
      return `${label} 杠杆调整 · ${before.leverageValue}x → ${after.leverageValue}x`;
    case "entry_price_changed":
      return `${label} 入场价更新 · ${before.entryPrice ?? "—"} → ${after.entryPrice ?? "—"}`;
    default:
      return null;
  }
}

function buildChange(
  position: PositionSnapshot,
  kind: PositionChangeKind,
  before: PositionSnapshot | null,
  after: PositionSnapshot | null,
): PositionChange {
  const descriptor: PositionChangeDescriptor = {
    dex: position.dex,
    coin: position.coin,
    kind,
    before,
    after,
  };
  return {
    ...descriptor,
    summary: describePositionChange(descriptor) ?? displayPosition(position.dex, position.coin),
  };
}

export function detectPositionChanges(
  previous: PositionSnapshot[],
  current: PositionSnapshot[],
): PositionChange[] {
  const previousByKey = new Map(previous.map((position) => [positionKey(position), position]));
  const currentByKey = new Map(current.map((position) => [positionKey(position), position]));
  const keys = [...new Set([...previousByKey.keys(), ...currentByKey.keys()])].sort();
  const changes: PositionChange[] = [];

  for (const key of keys) {
    const before = previousByKey.get(key) ?? null;
    const after = currentByKey.get(key) ?? null;
    const position = after ?? before;
    if (!position) continue;

    if (!before && after) {
      changes.push(buildChange(position, "opened", null, after));
      continue;
    }

    if (before && !after) {
      changes.push(buildChange(position, "closed", before, null));
      continue;
    }

    if (!before || !after) continue;

    const sizeChanged = !decimalEquals(before.size, after.size);

    if (sizeChanged && decimalSign(before.size) !== decimalSign(after.size)) {
      changes.push(buildChange(position, "flipped", before, after));
      continue;
    }

    if (sizeChanged) {
      const increased = compareAbsoluteDecimals(after.size, before.size) > 0;
      changes.push(buildChange(position, increased ? "increased" : "reduced", before, after));
      continue;
    }

    const leverageChanged =
      before.leverageType !== after.leverageType ||
      before.leverageValue !== after.leverageValue;

    if (leverageChanged) {
      changes.push(buildChange(position, "leverage_changed", before, after));
      continue;
    }

    if (!decimalEquals(before.entryPrice, after.entryPrice)) {
      changes.push(buildChange(position, "entry_price_changed", before, after));
    }
  }

  return changes;
}
