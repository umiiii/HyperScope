import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "@/app/api/push/test/route";

test("测试推送接口拒绝跨站、非 JSON、超大与无效订阅请求", async (t) => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://h.umi.cat";
  t.after(() => {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  });

  const crossOrigin = await POST(
    new Request("https://h.umi.cat/api/push/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await POST(
    new Request("https://h.umi.cat/api/push/test", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://h.umi.cat",
      },
      body: "{}",
    }),
  );
  assert.equal(wrongContentType.status, 415);

  const streamedOversizedRequest = new Request("https://h.umi.cat/api/push/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://h.umi.cat",
    },
    body: JSON.stringify({ padding: "x".repeat(8_192) }),
  });
  assert.equal(streamedOversizedRequest.headers.get("content-length"), null);
  const oversized = await POST(streamedOversizedRequest);
  assert.equal(oversized.status, 413);

  const declaredOversized = await POST(
    new Request("https://h.umi.cat/api/push/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "8193",
        Origin: "https://h.umi.cat",
      },
      body: "{}",
    }),
  );
  assert.equal(declaredOversized.status, 413);

  const invalidSubscription = await POST(
    new Request("https://h.umi.cat/api/push/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://h.umi.cat",
      },
      body: JSON.stringify({ subscription: { endpoint: "https://example.com" } }),
    }),
  );
  assert.equal(invalidSubscription.status, 400);
});
