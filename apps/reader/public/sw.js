/**
 * Tela's app-shell service worker (ADR 0025). It keeps the shell, and only the shell:
 *
 * - a navigation gets the cached index.html at once and refreshes it behind (stale while
 *   revalidate), so a repeat visit paints without waiting on the network;
 * - `/assets/*` are content-hashed, so a cached copy is served forever. Only a copy that is what
 *   its name says is kept: the edge answers a hashed file its deploy lacks 200 with the app's
 *   HTML (ARCHITECTURE.md), which kept under a script's name would be served forever too;
 * - the cached index.html is replaced only once every file the new one loads is cached, and the
 *   files of the one it replaces are kept, so whichever shell a navigation gets boots offline and
 *   after the deploy that removed its files from the network;
 * - `/api/*`, `/o/*` and `/img/*` are never touched: the local store and the edge own those.
 *
 * What index.html loads (its scripts, stylesheets and preloads) is fetched before the swap. Fonts
 * are cached as the page asks for them, since a page loads only the few its text needs; they are
 * kept while a kept stylesheet names them. Dynamic `import()` chunks are not precached either:
 * the build has one JS bundle today, and a lazy chunk would be cached only once a page loaded it.
 *
 * Bump SHELL whenever a released worker may have cached something wrong: activation drops every
 * other cache and warms the new one (OPERATIONS.md).
 *
 * Kill switch: `shell/kill-sw.js` (OPERATIONS.md) replaces this file when a bad shell must go.
 */
const SHELL = 'tela-shell-v2'
/** How long activation waits for its warm before it lets the open tabs' requests through. */
const WARM_MS = 3000
const PASS = /^\/(api|o|img|avatar)\//
const ICONS = new Set(['/favicon.ico', '/icon.svg', '/apple-icon.png'])
/** What a hashed file's content type must name, by extension. */
const TYPES = { js: 'javascript', css: 'text/css', woff2: 'font/woff2', woff: 'font/woff' }

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key)
      await self.clients.claim()
      // A new cache is empty: warm it, so the next navigation has a shell to paint. The open
      // tabs' requests wait while a worker activates, so the warm has WARM_MS; one the network
      // has not finished by then goes on behind, and the next navigation tries again if it fails.
      const warm = refreshShell().catch(() => undefined)
      await Promise.race([warm, new Promise((done) => setTimeout(done, WARM_MS))])
    })(),
  )
})

/** A response worth keeping under a hashed name: what the name says it is, and never the app. */
function fits(path, res) {
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!res.ok || type.includes('text/html')) return false
  const want = TYPES[path.slice(path.lastIndexOf('.') + 1)]
  return !want || type.includes(want)
}

/** The `/assets/…` files a page loads itself: script `src` and link `href` (CSS, modulepreload). */
function loads(html) {
  const refs = new Set()
  for (const m of html.matchAll(
    /<(?:script|link)\b[^>]*?\s(?:src|href)=["']?(\/assets\/[^"'\s>]+)/g,
  ))
    refs.add(m[1])
  return refs
}

/** Every `/assets/…` a shell uses: what its page loads, and the fonts its stylesheets name. */
async function uses(cache, html) {
  const refs = loads(html)
  for (const ref of [...refs]) {
    if (!ref.endsWith('.css')) continue
    const css = await cache.match(ref)
    const text = css ? await css.text() : ''
    for (const m of text.matchAll(/url\(([^)]+)\)/g)) {
      // A url() that is no URL names nothing to keep; it must not stop the swap.
      try {
        const url = new URL(m[1].trim().replace(/["']/g, ''), new URL(ref, self.location.origin))
        if (url.origin === self.location.origin) refs.add(url.pathname)
      } catch {}
    }
  }
  return refs
}

/**
 * The shell before the cached one: the last shell a refresh replaced. Its files stay, since a tab
 * may still be booting it. Kept under a key of its own, because a refresh that finds the shell
 * unchanged must not take the current one for it and drop the files that tab is about to ask for.
 */
const PREVIOUS = '/__tela/previous-shell'

/** The refresh in flight, which a second navigation joins instead of fetching the shell again. */
let refreshing = null

/** Refresh the cached shell, one refresh at a time. */
function refreshShell() {
  refreshing ??= swapShell().finally(() => {
    refreshing = null
  })
  return refreshing
}

/**
 * Fetch the shell, cache every file it loads that is missing, and only then replace the cached
 * one. A file the network cannot give, or answers with something else (the app itself, a
 * captive portal), leaves the old shell and its files as they were: the next refresh tries again.
 * The previous shell's files stay, since a tab may be booting it right now (`PREVIOUS`);
 * anything older goes.
 */
async function swapShell() {
  const res = await fetch('/', { cache: 'no-cache' })
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return
  const html = await res.clone().text()
  const cache = await caches.open(SHELL)
  const ready = await Promise.all(
    [...loads(html)].map(async (path) => {
      if (await cache.match(path)) return true
      const asset = await fetch(path).catch(() => null)
      if (!asset || !fits(path, asset)) return false
      await cache.put(path, asset)
      return true
    }),
  )
  if (ready.includes(false)) return
  const current = await cache.match('/')
  const was = current ? await current.text() : null
  // Only a shell this refresh replaces becomes the previous one; an unchanged refresh keeps it.
  if (was !== null && was !== html) {
    await cache.put(PREVIOUS, new Response(was, { headers: { 'content-type': 'text/html' } }))
  }
  const previous = await cache.match(PREVIOUS)
  const keep = await uses(cache, html)
  if (previous) for (const ref of await uses(cache, await previous.text())) keep.add(ref)
  await cache.put('/', res)
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req)
  }
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
        event.waitUntil(refreshShell().catch(() => undefined))
        if (cached) return cached
        // No shell yet: whatever the network says, including the edge's rendered public pages.
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
        // Passed on whatever it is, but kept only if it is what the name says.
        if (fits(url.pathname, res)) await cache.put(url.pathname, res.clone())
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
