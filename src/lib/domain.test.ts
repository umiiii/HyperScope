import assert from "node:assert/strict";
import test from "node:test";
import { latestFetchedAt } from "@/lib/domain";

test("latestFetchedAt returns the newest fetch time", () => {
  assert.equal(
    latestFetchedAt([
      { lastCheckedAt: "2026-08-23T07:00:00.000Z" },
      { lastCheckedAt: "2026-08-23T07:04:05.000Z" },
      { lastCheckedAt: "2026-08-23T06:00:00.000Z" },
    ]),
    "2026-08-23T07:04:05.000Z",
  );
});

test("latestFetchedAt skips addresses without a usable fetch time", () => {
  assert.equal(latestFetchedAt([]), null);
  assert.equal(latestFetchedAt([{ lastCheckedAt: null }]), null);
  assert.equal(latestFetchedAt([{ lastCheckedAt: "not-a-date" }]), null);
  assert.equal(
    latestFetchedAt([
      { lastCheckedAt: null },
      { lastCheckedAt: "2026-08-23T07:00:00.000Z" },
    ]),
    "2026-08-23T07:00:00.000Z",
  );
});
