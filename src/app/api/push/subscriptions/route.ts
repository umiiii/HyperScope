import {
  isValidPushSubscription,
  removePushSubscription,
  savePushSubscription,
} from "@/lib/repository/push-subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const subscription =
    typeof body === "object" && body !== null && "subscription" in body
      ? (body as { subscription: unknown }).subscription
      : null;

  if (!isValidPushSubscription(subscription)) {
    return Response.json(
      { success: false, message: "推送订阅格式无效。" },
      { status: 400 },
    );
  }

  await savePushSubscription(subscription, request.headers.get("user-agent"));
  return Response.json({ success: true });
}

export async function DELETE(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const endpoint =
    typeof body === "object" &&
    body !== null &&
    "endpoint" in body &&
    typeof (body as { endpoint: unknown }).endpoint === "string"
      ? (body as { endpoint: string }).endpoint
      : null;

  if (!endpoint) {
    return Response.json(
      { success: false, message: "缺少订阅 endpoint。" },
      { status: 400 },
    );
  }

  await removePushSubscription(endpoint);
  return Response.json({ success: true });
}
