import type {
  PositionChange,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";

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

export function detectPositionChanges(
  previous: PositionSnapshot[],
  current: PositionSnapshot[],
): PositionChange[] {
  const previousByCoin = new Map(previous.map((position) => [position.coin, position]));
  const currentByCoin = new Map(current.map((position) => [position.coin, position]));
  const coins = [...new Set([...previousByCoin.keys(), ...currentByCoin.keys()])].sort();
  const changes: PositionChange[] = [];

  for (const coin of coins) {
    const before = previousByCoin.get(coin) ?? null;
    const after = currentByCoin.get(coin) ?? null;

    if (!before && after) {
      changes.push({
        coin,
        kind: "opened",
        before: null,
        after,
        summary: `${coin} 开仓 · ${direction(after.size)} ${absoluteSize(after.size)}`,
      });
      continue;
    }

    if (before && !after) {
      changes.push({
        coin,
        kind: "closed",
        before,
        after: null,
        summary: `${coin} 平仓 · 原${direction(before.size)} ${absoluteSize(before.size)}`,
      });
      continue;
    }

    if (!before || !after) continue;

    const sizeChanged = !decimalEquals(before.size, after.size);

    if (sizeChanged && decimalSign(before.size) !== decimalSign(after.size)) {
      changes.push({
        coin,
        kind: "flipped",
        before,
        after,
        summary: `${coin} 反向 · ${direction(before.size)} → ${direction(after.size)}`,
      });
      continue;
    }

    if (sizeChanged) {
      const increased = compareAbsoluteDecimals(after.size, before.size) > 0;
      changes.push({
        coin,
        kind: increased ? "increased" : "reduced",
        before,
        after,
        summary: `${coin} ${increased ? "加仓" : "减仓"} · ${absoluteSize(before.size)} → ${absoluteSize(after.size)}`,
      });
      continue;
    }

    const leverageChanged =
      before.leverageType !== after.leverageType ||
      before.leverageValue !== after.leverageValue;

    if (leverageChanged) {
      changes.push({
        coin,
        kind: "leverage_changed",
        before,
        after,
        summary: `${coin} 杠杆调整 · ${before.leverageValue}x → ${after.leverageValue}x`,
      });
      continue;
    }

    if (!decimalEquals(before.entryPrice, after.entryPrice)) {
      changes.push({
        coin,
        kind: "entry_price_changed",
        before,
        after,
        summary: `${coin} 入场价更新 · ${before.entryPrice ?? "—"} → ${after.entryPrice ?? "—"}`,
      });
    }
  }

  return changes;
}
