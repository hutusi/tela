/**
 * tela-redirect retires the old address's shell worker (ADR 0042), in Chromium, the one place the
 * suite lets a service worker run. Two local origins stand in for tela.ainaive.com and
 * telaread.com, apart from the stack. The old one first serves the shell through the real
 * `public/sw.js`, as tela-web did; then it answers as tela-redirect does. A plain redirect never
 * reaches a browser that keeps the worker, since the worker answers every navigation from its
 * cache; the kill switch at `/sw.js` does, and takes the open tabs to the new origin with it.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import redirect, { ORIGIN } from '../redirect/index'

const SW = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')

/** A plain shell, as `sw.js` keeps one: an empty root, no handover. It registers the worker. */
const shell = (where: string) =>
  `<!doctype html><meta charset="utf-8"><title>${where}</title><div id="root"></div><p id="where">${where}</p><script>navigator.serviceWorker.register('/sw.js')</script>`
const page = (where: string) =>
  `<!doctype html><meta charset="utf-8"><title>${where}</title><p id="where">${where}</p>`

/** What the old origin is: the app, a redirect rule and nothing else, tela-redirect, or empty. */
let mode: 'app' | 'redirect-all' | 'moved' | 'probe' = 'app'
let oldOrigin = ''
let newOrigin = ''
const servers: Server[] = []

async function send(res: ServerResponse, answer: Response) {
  res.writeHead(answer.status, Object.fromEntries(answer.headers))
  res.end(await answer.text())
}

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })

async function oldSite(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? '/', oldOrigin)
  if (mode === 'probe') return html(page('probe'))
  if (mode === 'redirect-all')
    return Response.redirect(`${newOrigin}${url.pathname}${url.search}`, 301)
  if (mode === 'moved') {
    const answer = redirect.fetch(new Request(url, { method: req.method ?? 'GET' }))
    const location = answer.headers.get('location')
    return location ? Response.redirect(location.replace(ORIGIN, newOrigin), answer.status) : answer
  }
  if (url.pathname === '/sw.js')
    return new Response(SW, { headers: { 'content-type': 'text/javascript' } })
  // The shell the worker keeps, and every other path as the network gives it.
  return html(shell(url.pathname === '/__tela/shell' ? 'cached' : 'network'))
}

async function listen(handle: (req: IncomingMessage) => Promise<Response>) {
  const server = createServer((req, res) => void handle(req).then((answer) => send(res, answer)))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test.beforeAll(async () => {
  oldOrigin = await listen(oldSite)
  newOrigin = await listen(async () => html(page('new')))
})

test.afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))))
})

test('a browser that kept the old worker follows the redirect once /sw.js is the kill switch', async ({
  context,
  page: tab,
}) => {
  mode = 'app'
  await tab.goto(`${oldOrigin}/reading`)
  await expect
    .poll(() =>
      tab.evaluate(async () => !!navigator.serviceWorker.controller && !!(await caches.match('/'))),
    )
    .toBe(true)
  const other = await context.newPage()
  await other.goto(`${oldOrigin}/about`)
  await expect(other.locator('#where')).toHaveText('cached')

  // A redirect rule alone: the worker answers the navigation from its cache, and its update
  // fetch refuses the redirected script, so the old shell paints on the old origin.
  mode = 'redirect-all'
  await tab.goto(`${oldOrigin}/reading?x=1`)
  await expect(tab.locator('#where')).toHaveText('cached')
  expect(tab.url()).toBe(`${oldOrigin}/reading?x=1`)

  // tela-redirect: the update check finds the kill switch, which sends both tabs on.
  mode = 'moved'
  await tab.goto(`${oldOrigin}/reading?x=1`, { waitUntil: 'commit' })
  await expect(tab).toHaveURL(`${newOrigin}/reading?x=1`, { timeout: 20_000 })
  await expect(other).toHaveURL(`${newOrigin}/about`, { timeout: 20_000 })
  await expect(tab.locator('#where')).toHaveText('new')

  // Nothing of the old worker is left: a page on the old origin comes from the network.
  mode = 'probe'
  const probe = await context.newPage()
  await probe.goto(`${oldOrigin}/reading`)
  await expect(probe.locator('#where')).toHaveText('probe')
  expect(
    await probe.evaluate(async () => ({
      controlled: !!navigator.serviceWorker.controller,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      caches: await caches.keys(),
    })),
  ).toEqual({ controlled: false, registrations: 0, caches: [] })
})
