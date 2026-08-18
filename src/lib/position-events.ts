import type { PositionEvent } from "@/lib/domain";
import { describePositionChange } from "@/lib/hyperliquid/diff";
import type { PositionChangeKind } from "@/lib/hyperliquid/types";

/** Change kinds that repeat as a position is worked in or out over several
 *  checks, so a run of them describes one continuous move. */
const MERGEABLE_KINDS = new Set<PositionEvent["kind"]>([
  "increased",
  "reduced",
  "leverage_changed",
  "entry_price_changed",
]);

export type MergedPositionEvent = PositionEvent & {
  /** How many raw events this row stands for; 1 when nothing was merged. */
  mergedCount: number;
  /** Detection time of the oldest raw event in the row. */
  firstDetectedAt: string;
};

function isMergeableKind(kind: PositionEvent["kind"]): kind is PositionChangeKind {
  return MERGEABLE_KINDS.has(kind);
}

function timestamp(event: PositionEvent) {
  const value = new Date(event.detectedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function isSameRun(left: PositionEvent, right: PositionEvent) {
  return (
    isMergeableKind(left.kind) &&
    left.kind === right.kind &&
    left.dex === right.dex &&
    left.coin === right.coin
  );
}

function collapse(run: PositionEvent[]): MergedPositionEvent {
  const [lead] = run;
  if (run.length === 1) {
    return { ...lead, mergedCount: 1, firstDetectedAt: lead.detectedAt };
  }

  const chronological = [...run].sort((left, right) => timestamp(left) - timestamp(right));
  const oldest = chronological[0];
  const newest = chronological[chronological.length - 1];
  const before = oldest.before;
  const after = newest.after;
  const summary = isMergeableKind(newest.kind)
    ? describePositionChange({
        dex: newest.dex ?? "",
        coin: newest.coin ?? "",
        kind: newest.kind,
        before,
        after,
      })
    : null;

  return {
    ...lead,
    before,
    after,
    summary: summary ?? newest.summary,
    detectedAt: newest.detectedAt,
    firstDetectedAt: oldest.detectedAt,
    mergedCount: run.length,
  };
}

/**
 * Folds neighbouring changes of the same position and kind into one row, so a
 * position scaled in over many checks reads as a single move from its first
 * size to its latest one. Only directly adjacent events merge — any other
 * event in between keeps the timeline honest by splitting the run.
 */
export function mergeAdjacentPositionEvents(events: PositionEvent[]): MergedPositionEvent[] {
  const runs: PositionEvent[][] = [];

  for (const event of events) {
    const current = runs[runs.length - 1];
    if (current && isSameRun(current[0], event)) current.push(event);
    else runs.push([event]);
  }

  return runs.map(collapse);
}
