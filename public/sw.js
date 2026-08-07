const APP_NAME = "HyperScope";
const DEFAULT_URL = "/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {
    title: APP_NAME,
    body: "你有一条新的仓位通知。",
    icon: "/icons/icon-192",
    badge: "/icons/icon-192",
    url: DEFAULT_URL,
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text() || data.body;
    }
  }

  const targetUrl = new URL(data.url || DEFAULT_URL, self.location.origin);
  if (targetUrl.origin !== self.location.origin) {
    targetUrl.href = new URL(DEFAULT_URL, self.location.origin).href;
  }

  event.waitUntil(
    self.registration.showNotification(data.title || APP_NAME, {
      body: data.body || "你有一条新的仓位通知。",
      icon: data.icon || "/icons/icon-192",
      badge: data.badge || "/icons/icon-192",
      tag: data.tag || "hyperscope-position-change",
      renotify: true,
      data: { url: targetUrl.pathname + targetUrl.search + targetUrl.hash },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const requestedPath = event.notification.data?.url || DEFAULT_URL;
      const targetUrl = new URL(requestedPath, self.location.origin);
      const safeUrl =
        targetUrl.origin === self.location.origin
          ? targetUrl.href
          : new URL(DEFAULT_URL, self.location.origin).href;
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          if ("navigate" in client) await client.navigate(safeUrl);
          return client.focus();
        }
      }

      return self.clients.openWindow(safeUrl);
    })(),
  );
});
