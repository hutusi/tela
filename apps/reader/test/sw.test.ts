/**
 * The app-shell service worker (`public/sw.js`), run as the browser would run it: its source
 * evaluated against a CacheStorage in memory and a scripted network that deploys, answers a file
 * a deploy lacks with the app (as tela-web's asset router does), and goes offline.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const ORIGIN = 'https://tela.test'
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const SHELL = 'tela-shell-v2'

type File = { body: string; type: string }
type Deploy = ReturnType<typeof build>
type Req = { method: string; url: string; mode: string }
type Handler = (event: unknown) => void
type Worker = { handlers: Map<string, Handler> }

/** A build as Vite emits it: index.html naming its script and stylesheet, which names a font. */
function build(id: string, font = 'figtree-1') {
  const js = `/assets/index-${id}.js`
  const css = `/assets/index-${id}.css`
  const woff2 = `/assets/${font}.woff2`
  const html = `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <script type="module" crossorigin src="${js}"></script>
    <link rel="stylesheet" crossorigin href="${css}">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
  const files = new Map<string, File>([
    ['/', { body: html, type: 'text/html; charset=utf-8' }],
    [js, { body: `console.log(${JSON.stringify(id)})`, type: 'text/javascript' }],
    [
      css,
      {
        body: `@font-face{font-family:Figtree;src:url(${woff2}) format("woff2")}`,
        type: 'text/css; charset=utf-8',
      },
    ],
    [woff2, { body: `font ${font}`, type: 'font/woff2' }],
  ])
  return { id, html, js, css, woff2, files }
}

const keyOf = (key: string | { url: string }) =>
  new URL(typeof key === 'string' ? key : key.url, ORIGIN).href

/** CacheStorage in memory. `put` reads the body, as the real one does. */
function memoryCaches() {
  const stores = new Map<string, Map<string, { body: ArrayBuffer; init: ResponseInit }>>()
  const cache = (name: string) => {
    let store = stores.get(name)
    if (!store) {
      store = new Map()
      stores.set(name, store)
    }
    const s = store
    return {
      async match(key: string | { url: string }) {
        const hit = s.get(keyOf(key))
        return hit ? new Response(hit.body.slice(0), hit.init) : undefined
      },
      async put(key: string | { url: string }, res: Response) {
        const init = { status: res.status, headers: new Headers(res.headers) }
        s.set(keyOf(key), { body: await res.arrayBuffer(), init })
      },
      async delete(key: string | { url: string }) {
        return s.delete(keyOf(key))
      },
      async keys() {
        return [...s.keys()].map((url) => ({ url }))
      },
    }
  }
  return {
    stores,
    open: async (name: string) => cache(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    /** What any cache holds under a path (`caches.match`), without going through the worker. */
    async file(path: string): Promise<File | null> {
      for (const name of stores.keys()) {
        const hit = await cache(name).match(path)
        if (hit) return { body: await hit.text(), type: hit.headers.get('content-type') ?? '' }
      }
      return null
    },
    /** Drop a path from every cache, as nothing the worker does would. */
    forget(path: string) {
      for (const store of stores.values()) store.delete(keyOf(path))
    },
  }
}

let caches: ReturnType<typeof memoryCaches>
/** The deploy the edge serves right now. */
let live: Deploy
let offline: boolean
/** A network that takes every request and never answers. */
let hanging: boolean
/** Every path the network was asked for, and when the worker claimed its clients. */
let log: string[]

async function network(input: string | { url: string }): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN)
  const deploy = live
  const down = offline
  log.push(url.pathname)
  if (hanging) await new Promise(() => {})
  // The network is slower than the cache: whatever the page asks the cache for comes first.
  await new Promise((r) => setTimeout(r, 1))
  if (down) throw new TypeError('Failed to fetch')
  const file = deploy.files.get(url.pathname)
  if (file) return new Response(file.body, { headers: { 'content-type': file.type } })
  // A path this deploy has no file for: the app, 200. The asset router answers a missing hashed
  // file so too (run_worker_first is a list, so its fallback covers every request), and a
  // captive portal or proxy may say the same.
  return new Response(deploy.html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** Evaluate sw.js, install it and let it activate, as a browser does after registering it. */
async function start(): Promise<Worker> {
  const handlers = new Map<string, Handler>()
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => {
        log.push('claim')
      },
    },
  }
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, network)
  handlers.get('install')?.({ waitUntil: () => undefined })
  const behind: Promise<unknown>[] = []
  handlers.get('activate')?.({ waitUntil: (p: Promise<unknown>) => behind.push(p) })
  for (let i = 0; i < behind.length; i++) await behind[i]
  return { handlers }
}

const request = (path: string, mode = 'no-cors'): Req => ({
  method: 'GET',
  url: `${ORIGIN}${path}`,
  mode,
})

/** One fetch event: its answer, and a promise for everything it left running behind. */
function dispatch(sw: Worker, req: Req) {
  let answer: Promise<Response> | undefined
  const behind: Promise<unknown>[] = []
  sw.handlers.get('fetch')?.({
    request: req,
    respondWith: (p: Promise<Response>) => {
      answer = p
    },
    waitUntil: (p: Promise<unknown>) => behind.push(p),
  })
  // Not answered by the worker: the browser goes to the network itself.
  const response = answer ?? network(req.url)
  const settled = async () => {
    await response.catch(() => undefined)
    for (let i = 0; i < behind.length; i++) await behind[i]
  }
  return { response, settled }
}

const loadedBy = (html: string) =>
  [...html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (m) => m[1] ?? '',
  )

/**
 * A page load: the navigation, then every file the page it got loads and the fonts its
 * stylesheet names, as a browser asks for them, and last whatever the navigation left running.
 */
async function visit(sw: Worker, path = '/reading') {
  const nav = dispatch(sw, request(path, 'navigate'))
  const html = await (await nav.response).text()
  const files = new Map<string, File | null>()
  const load = async (ref: string) => {
    const res = await dispatch(sw, request(ref)).response.catch(() => null)
    const file = res
      ? { body: await res.text(), type: res.headers.get('content-type') ?? '' }
      : null
    files.set(ref, file)
    return file
  }
  for (const ref of loadedBy(html)) {
    const file = await load(ref)
    if (!ref.endsWith('.css') || !file) continue
    for (const m of file.body.matchAll(/url\(([^)]+)\)/g)) await load(m[1] ?? '')
  }
  await nav.settled()
  return { html, files }
}

/** A file as the deploy built it. */
const asBuilt = (deploy: Deploy, path: string) => deploy.files.get(path) ?? null

beforeEach(() => {
  caches = memoryCaches()
  hanging = false
  offline = false
  log = []
})

describe('the app-shell service worker', () => {
  test('a deploy between visits: the old shell boots, the new one is ready, offline too', async () => {
    const A = build('A')
    const B = build('B')
    live = A
    const sw = await start()
    await visit(sw)

    live = B
    const second = await visit(sw)
    // Stale while revalidate: this visit is A, from the cache, whole.
    expect(second.html).toBe(A.html)
    for (const path of [A.js, A.css, A.woff2])
      expect(second.files.get(path)).toEqual(asBuilt(A, path))
    // The refresh behind it cached what B loads before it made B the shell, and kept A's files.
    expect(await caches.file('/')).toEqual(asBuilt(B, '/'))
    for (const path of [B.js, B.css]) expect(await caches.file(path)).toEqual(asBuilt(B, path))
    for (const path of [A.js, A.css, A.woff2])
      expect(await caches.file(path)).toEqual(asBuilt(A, path))
    // A tab still booting A gets its files from the cache, not from the network (the app now).
    const late = await dispatch(sw, request(A.js)).response
    expect(await late.text()).toBe(A.files.get(A.js)?.body ?? '')

    offline = true
    const third = await visit(sw)
    expect(third.html).toBe(B.html)
    for (const path of [B.js, B.css, B.woff2])
      expect(third.files.get(path)).toEqual(asBuilt(B, path))
  })

  test('a file the network answers with the app is passed on, never kept, and the shell stays', async () => {
    const A = build('A')
    const B = build('B')
    B.files.delete(B.js)
    live = A
    const sw = await start()
    await visit(sw)

    live = B
    await visit(sw)
    expect(await caches.file('/')).toEqual(asBuilt(A, '/'))
    expect(await caches.file(B.js)).toBeNull()
    for (const path of [A.js, A.css]) expect(await caches.file(path)).toEqual(asBuilt(A, path))

    // Asked for directly, it is what the network said, and still not kept.
    const res = await dispatch(sw, request(B.js)).response
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await caches.file(B.js)).toBeNull()
    // Nor under a name whose type the worker has no rule for.
    await dispatch(sw, request('/assets/logo-gone.png')).response
    expect(await caches.file('/assets/logo-gone.png')).toBeNull()

    // Once the network has the file, the next refresh swaps.
    B.files.set(B.js, { body: 'console.log("B")', type: 'text/javascript' })
    await visit(sw)
    expect(await caches.file('/')).toEqual(asBuilt(B, '/'))
    expect(await caches.file(B.js)).toEqual(asBuilt(B, B.js))
  })

  test('a script or stylesheet answered as another type is not kept, and the shell stays', async () => {
    // Found in review: every wrong answer above is text/html, so nothing showed that the type
    // must also match the name.
    for (const wrong of ['js', 'css'] as const) {
      caches = memoryCaches()
      const A = build('A')
      const B = build('B')
      const path = wrong === 'js' ? B.js : B.css
      B.files.set(path, { body: 'not what the name says', type: 'text/plain' })
      live = A
      const sw = await start()
      await visit(sw)

      live = B
      await visit(sw)
      expect([wrong, await caches.file('/')]).toEqual([wrong, asBuilt(A, '/')])
      expect(await caches.file(path)).toBeNull()
      await dispatch(sw, request(path)).response
      expect(await caches.file(path)).toBeNull()
    }
  })

  test('two deploys: the shell cached last boots from the cache, the next one replaces it, the first goes', async () => {
    const A = build('A', 'figtree-1')
    const B = build('B', 'figtree-2')
    const C = build('C', 'figtree-2')
    live = A
    const sw = await start()
    await visit(sw)
    live = B
    await visit(sw)

    live = C
    const third = await visit(sw)
    // B boots whole, though the network has none of its scripts any more.
    expect(third.html).toBe(B.html)
    for (const path of [B.js, B.css, B.woff2])
      expect(third.files.get(path)).toEqual(asBuilt(B, path))
    expect(await caches.file('/')).toEqual(asBuilt(C, '/'))
    for (const path of [C.js, C.css]) expect(await caches.file(path)).toEqual(asBuilt(C, path))
    for (const path of [B.js, B.css, B.woff2])
      expect(await caches.file(path)).toEqual(asBuilt(B, path))
    for (const path of [A.js, A.css, A.woff2]) expect(await caches.file(path)).toBeNull()
  })

  test('with no shell cached, a navigation is the network, and the shell is kept before the event ends', async () => {
    const A = build('A')
    A.files.set('/discover', { body: '<!doctype html><title>Discover</title>', type: 'text/html' })
    live = A
    const sw = await start()
    // What `upgrade()` in src/shell.ts does before it reloads.
    for (const key of await caches.keys())
      if (key.startsWith('tela-shell')) await caches.delete(key)

    const nav = dispatch(sw, request('/discover', 'navigate'))
    expect(await (await nav.response).text()).toBe(A.files.get('/discover')?.body ?? '')
    // The browser may stop the worker once the event's promises settle: the refresh is one.
    await nav.settled()
    expect(await caches.file('/')).toEqual(asBuilt(A, '/'))
    for (const path of [A.js, A.css]) expect(await caches.file(path)).toEqual(asBuilt(A, path))
  })

  test('two navigations at once fetch the shell once', async () => {
    const A = build('A')
    live = A
    const sw = await start()
    await visit(sw)
    live = build('B')
    log = []

    const first = dispatch(sw, request('/reading', 'navigate'))
    const second = dispatch(sw, request('/discover', 'navigate'))
    expect(await (await first.response).text()).toBe(A.html)
    expect(await (await second.response).text()).toBe(A.html)
    await Promise.all([first.settled(), second.settled()])
    expect(log.filter((p) => p === '/')).toEqual(['/'])
  })

  test('the same shell, with a file it loads missing from the cache, fetches that file', async () => {
    const A = build('A')
    live = A
    const sw = await start()
    await visit(sw)
    caches.forget(A.css)

    await dispatch(sw, request('/reading', 'navigate')).settled()
    expect(await caches.file(A.css)).toEqual(asBuilt(A, A.css))
  })

  test('activation drops the earlier cache and warms its own', async () => {
    const A = build('A')
    live = A
    // What the worker before this one may have kept: the app under a script's name.
    const v1 = await caches.open('tela-shell-v1')
    await v1.put('/', new Response(A.html, { headers: { 'content-type': 'text/html' } }))
    await v1.put(A.js, new Response(A.html, { headers: { 'content-type': 'text/html' } }))

    const sw = await start()
    expect(await caches.keys()).toEqual([SHELL])
    // It claims the open tabs first, then warms.
    expect(log.slice(0, 2)).toEqual(['claim', '/'])
    expect(await caches.file('/')).toEqual(asBuilt(A, '/'))
    for (const path of [A.js, A.css]) expect(await caches.file(path)).toEqual(asBuilt(A, path))

    // So the first navigation after it already boots without the network.
    offline = true
    const first = await visit(sw)
    expect(first.html).toBe(A.html)
    for (const path of [A.js, A.css]) expect(first.files.get(path)).toEqual(asBuilt(A, path))
  })

  test('activation waits for its warm only so long: a network that hangs holds no tab for ever', async () => {
    // Fetch events wait while a worker activates, the open tabs' /api calls included.
    live = build('A')
    hanging = true
    const began = Date.now()
    await start()
    expect(Date.now() - began).toBeLessThan(4500)
    // The tabs were claimed, and are let through; the next navigation tries the warm again.
    expect(log).toEqual(['claim', '/'])
  }, 10_000)
})
