import assert from "node:assert/strict";
import test from "node:test";
import { formatFetchedAt } from "@/lib/client-format";

test("formatFetchedAt renders a full date and time", () => {
  const formatted = formatFetchedAt("2026-08-23T07:04:05.000Z");
  assert.match(formatted, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(formatted.startsWith("2026/"));
});

test("formatFetchedAt falls back when no fetch happened yet", () => {
  assert.equal(formatFetchedAt(null), "尚未获取数据");
  assert.equal(formatFetchedAt("not-a-date"), "尚未获取数据");
});
