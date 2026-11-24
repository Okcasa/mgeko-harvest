/* Chapter notifications for mgeko tags.
   The page registers this worker only after the reader opts in.  It has no
   fetch handler: the site is served normally, and this worker exists to receive
   pushes and route a notification click into the exact reader chapter. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let text = "";
  try {
    text = event.data ? event.data.text() : "";
  } catch (err) {
    text = "";
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { body: text };
  }

  const title = data.title || "new chapter";
  const options = {
    body: data.body || "A title you follow has a new chapter.",
    icon: data.icon || "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "chapter-update",
    renotify: Boolean(data.tag),
    timestamp: Date.now(),
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL(
    (event.notification.data && event.notification.data.url) || "/",
    self.location.origin
  );
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  event.waitUntil(self.clients.openWindow(target.href));
});
