export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatUsd(value: string | number, compact = false) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact && Math.abs(numeric) >= 10_000 ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
  }).format(numeric);
}

export function formatNumber(value: string | number, maximumFractionDigits = 6) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(numeric);
}

export function formatRelativeTime(value: string | null) {
  if (!value) return "尚未检查";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 30_000) return "刚刚";
  if (elapsed < 90_000) return "1 分钟前";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatFetchedAt(value: string | null) {
  if (!value) return "尚未获取数据";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "尚未获取数据";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatTimeOfDay(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatDateTimeRange(from: string, to: string) {
  const start = new Date(from);
  const end = new Date(to);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return `${formatDateTime(from)} → ${sameDay ? formatTimeOfDay(to) : formatDateTime(to)}`;
}
