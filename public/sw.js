// HuggingFound's service worker: it shows the notification the site sends
// through the browser's push service when a GPU watch rents a card (or
// ends), with the site's tab closed, and opens the site when it is clicked.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "HuggingFound", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "HuggingFound", { body: data.body || "", tag: "gpu-watch", icon: "/icon.svg", requireInteraction: data.kind === "rented", data: { url: "/" } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      const open = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow(event.notification.data?.url || "/");
    }),
  );
});
