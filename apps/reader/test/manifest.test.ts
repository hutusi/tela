/**
 * The web app manifest (`public/manifest.webmanifest`), which makes Tela installable: static files
 * that nothing else reads before a browser does, so this holds them to the app they describe.
 * `public.e2e.ts` checks they are served as what they are, not as the app's HTML.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAPER } from '../src/lib/typography'
import { publicRoute, renderPublicPage } from '../src/ssr'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path))

type Icon = { src: string; sizes: string; type: string; purpose: string }
const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8')) as {
  id: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: Icon[]
}
const INDEX = read('index.html').toString('utf8')

/** A PNG's size from its IHDR, which must be the first chunk, right after the signature. */
function pngSize(bytes: Buffer): string {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`
}

/** `--color-paper` in the first block that `selector` opens in styles.css. */
function paper(selector: string): string {
  const css = read('src/styles.css').toString('utf8')
  const at = css.indexOf(`${selector} {`)
  const value = css.slice(at, css.indexOf('}', at)).match(/--color-paper:\s*(#[0-9a-f]{6});/)?.[1]
  if (at === -1 || !value) throw new Error(`no --color-paper under ${selector} in styles.css`)
  return value
}

describe('the manifest', () => {
  test('names Tela, and opens standalone on the reading page', () => {
    expect(manifest).toMatchObject({ id: '/', name: 'Tela', short_name: 'Tela', scope: '/' })
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/reading')
  })

  test('starts inside its scope, on a page the Worker never runs for', () => {
    const scope = new URL(manifest.scope, 'https://tela.test')
    const start = new URL(manifest.start_url, scope)
    expect(start.origin).toBe(scope.origin)
    expect(start.pathname.startsWith(scope.pathname)).toBe(true)
    // `/` is two pages, the landing for a visitor and the shell for a member (ADR 0035): an
    // installed app opens on the shell, which the asset router answers without tela-web.
    const config = JSON.parse(
      read('wrangler.jsonc')
        .toString('utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { assets: { run_worker_first: string[] } }
    const runsFirst = (path: string) =>
      config.assets.run_worker_first.some((p) =>
        p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p,
      )
    expect(runsFirst(start.pathname)).toBe(false)
    // The manifest and its icons are static assets too.
    for (const path of ['/manifest.webmanifest', ...manifest.icons.map((i) => i.src)])
      expect(runsFirst(path)).toBe(false)
  })

  test('has every icon it names, at the size it says', () => {
    const by = (purpose: string) =>
      manifest.icons
        .filter((i) => i.purpose === purpose)
        .map((i) => i.sizes)
        .sort()
    // Chrome installs with a 192 and a 512; Android's launcher cuts its own shape from a maskable.
    expect(by('any')).toEqual(['192x192', '512x512'])
    expect(by('maskable')).toEqual(['512x512'])
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png')
      expect(pngSize(read(`public${icon.src}`))).toBe(icon.sizes)
    }
  })

  test("is on the page's paper, the same paper styles.css and the theme-color metas name", () => {
    const light = paper('@theme')
    const dark = paper(':root[data-theme="dark"]')
    expect(light).toBe('#f6f2ea')
    expect(dark).toBe('#1f1c18')
    // The system's dark is the same block written twice (styles.css says why).
    expect(paper(':root:not([data-theme="light"])')).toBe(dark)
    expect(manifest.theme_color).toBe(light)
    expect(manifest.background_color).toBe(light)
    expect<Record<string, string>>(PAPER).toEqual({ light, dark })
    const meta = (scheme: string) =>
      INDEX.match(
        new RegExp(
          `<meta name="theme-color" media="\\(prefers-color-scheme: ${scheme}\\)" content="([^"]+)"`,
        ),
      )?.[1]
    expect(meta('light')).toBe(light)
    expect(meta('dark')).toBe(dark)
  })
})

describe('the pages that name it', () => {
  const LINK = '<link rel="manifest" href="/manifest.webmanifest" />'

  test('the shell links the manifest', () => {
    expect(INDEX).toContain(LINK)
  })

  test('so does a page the edge pours into it', () => {
    const url = new URL('https://tela.test/about')
    const route = publicRoute(url)
    if (!route) throw new Error('/about is a public page')
    const html = renderPublicPage({ route, url, data: null, locale: 'en', now: 0, template: INDEX })
    expect(html).toContain('<div id="root"><')
    expect(html).toContain(LINK)
    expect(html.match(/<meta name="theme-color"/g)).toHaveLength(2)
  })
})
