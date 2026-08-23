import type {
  PositionChangeKind,
  PositionSnapshot,
} from "@/lib/hyperliquid/types";

export type MonitorStatus = "pending" | "healthy" | "error";

export type AddressSummary = {
  id: string;
  address: string;
  label: string | null;
  status: MonitorStatus;
  errorMessage: string | null;
  accountValue: string;
  withdrawable: string;
  totalMarginUsed: string;
  positionCount: number;
  unrealizedPnl: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  createdAt: string;
};

export type PositionEvent = {
  id: string;
  dex: string | null;
  coin: string | null;
  kind: PositionChangeKind | "monitor_started" | "monitor_scope_updated";
  summary: string;
  before: PositionSnapshot | null;
  after: PositionSnapshot | null;
  detectedAt: string;
};

export type WorkerStatus = {
  state: string;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  updatedAt: string;
} | null;

export type AddressDetail = AddressSummary & {
  positions: PositionSnapshot[];
  events: PositionEvent[];
};

export type DashboardData = {
  addresses: AddressSummary[];
  worker: WorkerStatus;
  monitorIntervalMs: number;
};

export function latestFetchedAt(
  addresses: readonly Pick<AddressSummary, "lastCheckedAt">[],
): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const address of addresses) {
    if (!address.lastCheckedAt) continue;
    const time = new Date(address.lastCheckedAt).getTime();
    if (!Number.isFinite(time) || time <= latestTime) continue;
    latest = address.lastCheckedAt;
    latestTime = time;
  }
  return latest;
}
