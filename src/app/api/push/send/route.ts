import { createHash, timingSafeEqual } from "node:crypto";
import webpush, {
  WebPushError,
  type PushSubscription as WebPushSubscription,
} from "web-push";
import { getPushRuntimeConfig, PushConfigurationError } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 5;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

type SendBody = {
  subscription?: unknown;
  message?: unknown;
  token?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidSubscription(value: unknown): value is WebPushSubscription {
  if (!isRecord(value) || !isRecord(value.keys)) return false;
  if (
    typeof value.endpoint !== "string" ||
    typeof value.keys.p256dh !== "string" ||
    typeof value.keys.auth !== "string" ||
    !value.keys.p256dh ||
    !value.keys.auth
  ) {
    return false;
  }

  try {
    const endpoint = new URL(value.endpoint);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLocalHostname =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal");
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");

    return (
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password &&
      !isLocalHostname &&
      !isIpLiteral
    );
  } catch {
    return false;
  }
}

function hasValidToken(expected: string | null, received: unknown) {
  if (!expected) return true;
  if (typeof received !== "string") return false;

  const expectedHash = createHash("sha256").update(expected).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash);
}

function rateLimitKey(request: Request, endpoint: string) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client = forwardedFor || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`${client}:${endpoint}`).digest("base64url");
}

function isRateLimited(key: string) {
  const now = Date.now();
  const current = rateLimits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  current.count += 1;
  if (rateLimits.size > 1_000) {
    for (const [entryKey, entry] of rateLimits) {
      if (entry.resetAt <= now) rateLimits.delete(entryKey);
    }
  }
  return current.count > MAX_SENDS_PER_WINDOW;
}

export async function POST(request: Request) {
  let config;
  try {
    config = getPushRuntimeConfig();
  } catch (error) {
    return Response.json(
      {
        success: false,
        message:
          error instanceof PushConfigurationError
            ? error.message
            : "推送服务配置暂时不可用。",
      },
      { status: 503 },
    );
  }

  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return Response.json(
      { success: false, message: "请求内容不是有效 JSON。" },
      { status: 400 },
    );
  }

  if (!hasValidToken(config.adminToken, body.token)) {
    return Response.json(
      { success: false, message: "测试口令不正确。" },
      { status: 401 },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 160 || !isValidSubscription(body.subscription)) {
    return Response.json(
      { success: false, message: "订阅信息无效，或通知内容超过 160 个字符。" },
      { status: 400 },
    );
  }

  const limiterKey = rateLimitKey(request, body.subscription.endpoint);
  if (isRateLimited(limiterKey)) {
    return Response.json(
      { success: false, message: "发送得太频繁，请一分钟后再试。" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const result = await webpush.sendNotification(
      body.subscription,
      JSON.stringify({
        title: "HyperScope",
        body: message,
        icon: "/icons/icon-192",
        badge: "/icons/icon-192",
        url: "/",
        sentAt: new Date().toISOString(),
      }),
      {
        TTL: 120,
        urgency: "high",
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      },
    );

    return Response.json({
      success: true,
      accepted: result.statusCode,
      message: "推送服务已接收通知。",
    });
  } catch (error) {
    if (error instanceof WebPushError) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        return Response.json(
          { success: false, message: "这条订阅已经失效，请重新开启推送。" },
          { status: 410 },
        );
      }
      if (error.statusCode === 429) {
        return Response.json(
          { success: false, message: "上游推送服务正在限流，请稍后再试。" },
          { status: 429 },
        );
      }
    }

    console.error("Web Push send failed", error);
    return Response.json(
      { success: false, message: "后端发送失败，请检查 VAPID 配置与 Railway 日志。" },
      { status: 502 },
    );
  }
}
