/**
 * Tela's app-shell service worker (ADR 0025). It keeps the shell, and only the shell:
 *
 * - a navigation gets the cached index.html at once and refreshes it behind (stale while
 *   revalidate), so a repeat visit paints without waiting on the network;
 * - `/assets/*` are content-hashed, so a cached copy is served forever;
 * - `/api/*`, `/o/*` and `/img/*` are never touched: the local store and the edge own those.
 *
 * Kill switch: `shell/kill-sw.js` (OPERATIONS.md) replaces this file when a bad shell must go.
 */
const SHELL = 'tela-shell-v1'
const PASS = /^\/(api|o|img)\//
const ICONS = new Set(['/favicon.ico', '/icon.svg', '/apple-icon.png'])

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

/** Every `/assets/…` the page and its stylesheets name: what the current shell needs. */
async function referenced(cache, html) {
  const refs = new Set(html.match(/\/assets\/[^"')\s]+/g) ?? [])
  for (const ref of [...refs]) {
    if (!ref.endsWith('.css')) continue
    const css = await cache.match(ref)
    const text = css ? await css.text() : ''
    for (const m of text.matchAll(/url\(([^)]+)\)/g)) {
      const u = m[1].replace(/["']/g, '')
      refs.add(u.startsWith('/') ? u : `/assets/${u.replace(/^\.\//, '')}`)
    }
  }
  return refs
}

/** Fetch the shell, keep it, and drop assets no shell needs any more. */
async function refreshShell() {
  const res = await fetch('/', { cache: 'no-cache' })
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return res
  const cache = await caches.open(SHELL)
  await cache.put('/', res.clone())
  const html = await res.clone().text()
  const keep = await referenced(cache, html)
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req)
  }
  return res
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || PASS.test(url.pathname) || url.pathname === '/sw.js')
    return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL)
        const cached = await cache.match('/')
        const fresh = refreshShell()
        if (cached) {
          event.waitUntil(fresh.catch(() => undefined))
          return cached
        }
        // First visit: whatever the network says, including the edge's rendered public pages.
        fresh.catch(() => undefined)
        return fetch(request)
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL)
        const cached = await cache.match(url.pathname)
        if (cached) return cached
        const res = await fetch(request)
        if (res.ok) await cache.put(url.pathname, res.clone())
        return res
      })(),
    )
    return
  }

  if (ICONS.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL)
        const cached = await cache.match(url.pathname)
        const fresh = fetch(request).then(async (res) => {
          if (res.ok) await cache.put(url.pathname, res.clone())
          return res
        })
        if (cached) {
          event.waitUntil(fresh.catch(() => undefined))
          return cached
        }
        return fresh
      })(),
    )
  }
})
