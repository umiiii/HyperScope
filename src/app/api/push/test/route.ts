import { deliverTestNotification } from "@/lib/notifications";
import {
  isValidPushSubscription,
  type PushSubscriptionInput,
} from "@/lib/repository/push-subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_LENGTH = 8_192;

type BodyReadResult =
  | { ok: true; value: string }
  | { ok: false; tooLarge: boolean };

async function readLimitedBody(request: Request): Promise<BodyReadResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, tooLarge: false };
    }
    if (parsedLength > MAX_BODY_LENGTH) {
      return { ok: false, tooLarge: true };
    }
  }

  if (!request.body) return { ok: true, value: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let value = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_BODY_LENGTH) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return { ok: true, value };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, tooLarge: false };
  }
}

function errorResponse(message: string, status: number, headers?: HeadersInit) {
  return Response.json(
    { success: false, message },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export async function POST(request: Request) {
  const requestOrigin = new URL(process.env.APP_URL || request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    origin !== requestOrigin ||
    (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
  ) {
    return errorResponse("测试推送只允许从当前站点发起。", 403);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("请求必须使用 JSON 格式。", 415);
  }

  const bodyResult = await readLimitedBody(request);
  if (!bodyResult.ok) {
    return errorResponse(
      bodyResult.tooLarge ? "测试推送请求不能超过 8 KB。" : "测试推送请求大小无效。",
      bodyResult.tooLarge ? 413 : 400,
    );
  }
  if (bodyResult.value.length === 0) {
    return errorResponse("测试推送请求不能为空。", 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyResult.value) as unknown;
  } catch {
    return errorResponse("测试推送请求格式无效。", 400);
  }
  const subscription =
    typeof body === "object" && body !== null && "subscription" in body
      ? (body as { subscription: unknown }).subscription
      : null;
  if (!isValidPushSubscription(subscription)) {
    return errorResponse("当前设备的推送订阅无效。", 400);
  }

  try {
    const result = await deliverTestNotification(
      subscription as PushSubscriptionInput,
    );
    if (result === "delivered") {
      return Response.json(
        { success: true, message: "测试通知已提交，请检查系统通知。" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (result === "cooldown" || result === "rate_limited") {
      return errorResponse(
        result === "cooldown"
          ? "请等待一分钟后再次测试。"
          : "测试推送请求较多，请稍后再试。",
        429,
        { "Retry-After": "60" },
      );
    }
    if (result === "expired") {
      return errorResponse("这台设备的订阅已失效，请重新开启通知。", 410);
    }
    return errorResponse("服务器找不到这台设备的推送订阅。", 404);
  } catch (error) {
    console.error("Test Web Push delivery failed", error);
    return errorResponse("推送服务暂时无法接收测试通知。", 502);
  }
}
