export type PositionSnapshot = {
  dex: string;
  coin: string;
  size: string;
  entryPrice: string | null;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPrice: string | null;
  marginUsed: string;
  leverageType: string;
  leverageValue: number;
  leverageRawUsd: string | null;
  maxLeverage: number | null;
};

export type AccountSnapshot = {
  accountValue: string;
  withdrawable: string;
  totalMarginUsed: string;
  positions: PositionSnapshot[];
  fetchedAt: Date;
  dexSnapshotTimes: Record<string, number>;
};

export type PositionChangeKind =
  | "opened"
  | "closed"
  | "increased"
  | "reduced"
  | "flipped"
  | "leverage_changed"
  | "entry_price_changed";

export type PositionChange = {
  dex: string;
  coin: string;
  kind: PositionChangeKind;
  before: PositionSnapshot | null;
  after: PositionSnapshot | null;
  summary: string;
};
