self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Wirral Community Football", body: event.data.text() };
  }

  const { title, body, url, sid } = payload;
  event.waitUntil(
    self.registration.showNotification(title || "Wirral Community Football", {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: url || "/", sid: sid || null },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  const sid = event.notification.data?.sid;

  // Count the tap (for open rates), sent alongside opening the app rather
  // than before it - opening a window has to happen straight off the tap.
  const logged = sid
    ? fetch("/api/push/opened", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid }),
        keepalive: true,
      }).catch(() => {})
    : Promise.resolve();

  const opened = (async () => {
    const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientsList) {
      if (client.url.includes(self.location.origin) && "focus" in client) {
        return client.focus();
      }
    }
    return clients.openWindow(url);
  })();

  event.waitUntil(Promise.all([opened, logged]));
});
