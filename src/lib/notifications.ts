import webpush, { WebPushError } from "web-push";
import {
  listPushSubscriptions,
  markPushFailure,
  markPushSuccess,
  removePushSubscriptionByHash,
} from "@/lib/repository/push-subscriptions";
import type { OutboxNotification } from "@/lib/repository/outbox";
import { getPushRuntimeConfig } from "@/lib/push";

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
