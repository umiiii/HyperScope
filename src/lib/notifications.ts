import webpush, { WebPushError } from "web-push";
import {
  claimPushSubscriptionForTest,
  listPushSubscriptions,
  markPushFailure,
  markPushSuccess,
  removePushSubscriptionByHash,
} from "@/lib/repository/push-subscriptions";
import type { PushSubscriptionInput } from "@/lib/repository/push-subscriptions";
import type { OutboxNotification } from "@/lib/repository/outbox";
import { getPushRuntimeConfig } from "@/lib/push";

export type TestPushResult =
  | "delivered"
  | "cooldown"
  | "expired"
  | "missing"
  | "rate_limited";

export async function deliverTestNotification(
  requestedSubscription: PushSubscriptionInput,
): Promise<TestPushResult> {
  const claim = await claimPushSubscriptionForTest(requestedSubscription);
  if (claim.status !== "claimed") return claim.status;

  const subscription = claim.subscription;
  const config = getPushRuntimeConfig();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify({
        title: "HyperScope 测试通知",
        body: "推送通道工作正常，后续仓位变化会通知这台设备。",
        url: "/",
        tag: "hyperscope-test-notification",
        icon: "/icons/icon-192",
        badge: "/icons/icon-192",
      }),
      {
        TTL: 60,
        urgency: "high",
        timeout: 10_000,
        vapidDetails: config,
      },
    );
    await markPushSuccess(subscription.endpointHash);
    return "delivered";
  } catch (error) {
    if (
      error instanceof WebPushError &&
      (error.statusCode === 404 || error.statusCode === 410)
    ) {
      await removePushSubscriptionByHash(subscription.endpointHash);
      return "expired";
    }

    await markPushFailure(subscription.endpointHash);
    throw error;
  }
}

export async function deliverNotification(notification: OutboxNotification) {
  const subscriptions = await listPushSubscriptions();
  if (subscriptions.length === 0) {
    return { delivered: 0, transientFailures: 0 };
  }
  const config = getPushRuntimeConfig();

  let delivered = 0;
  let transientFailures = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            title: notification.title,
            body: notification.body,
            url: notification.targetUrl,
            tag: notification.tag,
            icon: "/icons/icon-192",
            badge: "/icons/icon-192",
          }),
          {
            TTL: 300,
            urgency: "high",
            vapidDetails: config,
          },
        );
        delivered += 1;
        await markPushSuccess(subscription.endpointHash);
      } catch (error) {
        if (
          error instanceof WebPushError &&
          (error.statusCode === 404 || error.statusCode === 410)
        ) {
          await removePushSubscriptionByHash(subscription.endpointHash);
          return;
        }

        transientFailures += 1;
        await markPushFailure(subscription.endpointHash);
        console.error("Web Push delivery failed", error);
      }
    }),
  );

  return { delivered, transientFailures };
}
