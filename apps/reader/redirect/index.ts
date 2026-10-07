/**
 * tela-redirect (ADR 0042): Tela's old address, tela.ainaive.com, and the `www` name, sent to the
 * one origin the app is served from.
 *
 * Every request is redirected to the same path and query there, except the shell's service
 * worker. A browser that visited the old address holds a worker that answers every navigation
 * from its cached shell (`public/sw.js`), so it would never see a redirect, and a worker's update
 * fetch fails on one, so the old worker could never replace itself either. `/sw.js` is answered
 * with the kill switch instead: it drops the cached shell, unregisters itself and navigates each
 * open tab again, and that navigation reaches the redirect. Never redirect `/sw.js`.
 */

/** Where Tela lives. */
export const ORIGIN = 'https://telaread.com'

/** The code of `shell/kill-sw.js`, character for character (`test/redirect.test.ts`). */
export const KILL_SW = `self.addEventListener('install', () => self.skipWaiting())
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
`

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (url.pathname === '/sw.js') {
      return new Response(KILL_SW, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    }
    // 308 keeps a write a write; a browser only ever navigates here.
    const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308
    return Response.redirect(`${ORIGIN}${url.pathname}${url.search}`, status)
  },
}
