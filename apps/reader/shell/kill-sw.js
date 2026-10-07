/**
 * The kill switch for the app-shell service worker (OPERATIONS.md). Copied over `public/sw.js`
 * and deployed, it takes over on the next visit, drops every cached shell, unregisters itself,
 * and reloads open tabs so they come from the network.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key)
      await self.registration.unregister()
      // Awaited, so the worker is not stopped before every tab has been sent on its way.
      await Promise.all(
        (await self.clients.matchAll({ type: 'window' })).map((client) =>
          client.navigate(client.url).catch(() => null),
        ),
      )
    })(),
  )
})
