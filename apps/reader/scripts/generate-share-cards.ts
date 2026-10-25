#!/usr/bin/env bun
/**
 * Generates the share cards (ADR 0060): one 1200×630 PNG per interface language, which every
 * public page names as its `og:image` (`src/lib/head.ts`). The front page's headline and its
 * description, from the catalogues, beside the lockup, on the paper ground.
 *
 * Rendered by the Chromium that Playwright installs for `bun run e2e`, as the icons are
 * (`generate-icons.ts`): there is no SVG or text rasteriser on a stock macOS, and the Chinese cards
 * need the system's Songti and PingFang, which a browser finds by itself. Run
 * `cd apps/reader && bun run share-cards` after changing the copy or the design, and commit what it
 * writes; nothing calls this at build time.
 *
 * Output: public/og/<locale>.png. A missing card is answered by the single-page fallback with
 * index.html (AGENTS.md), so a new interface language needs its card in the same change.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { UI_LOCALES, type UiLocale } from '@tela/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..')
const OUT = join(APP, 'public', 'og')
const FONTS = join(APP, 'node_modules', '@fontsource')

const PAPER = '#f6f2ea'
const INK = '#1f1c18'
const INK_2 = '#5c554b'
/** `--color-accent` on the paper ground, oklch(0.5 0.1 150), as styles.css has it. */
const ACCENT = 'oklch(0.5 0.1 150)'

/** The CJK faces after EB Garamond and Figtree, each Chinese in its own script (styles.css). */
const SERIF: Record<UiLocale, string> = {
  en: '"EB Garamond", Georgia, serif',
  fr: '"EB Garamond", Georgia, serif',
  'zh-Hans': '"EB Garamond", "Songti SC", "Noto Serif CJK SC", serif',
  'zh-Hant': '"EB Garamond", "Songti TC", "Noto Serif CJK TC", serif',
}
const SANS: Record<UiLocale, string> = {
  en: 'Figtree, system-ui, sans-serif',
  fr: 'Figtree, system-ui, sans-serif',
  'zh-Hans': 'Figtree, "PingFang SC", "Noto Sans CJK SC", sans-serif',
  'zh-Hant': 'Figtree, "PingFang TC", "Noto Sans CJK TC", sans-serif',
}

async function font(family: string, file: string, weight: number, style: string) {
  const bytes = await readFile(join(FONTS, file.split('-latin')[0] as string, 'files', file))
  return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style};
    src: url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2"); }`
}

const faces = (
  await Promise.all([
    font('EB Garamond', 'eb-garamond-latin-500-normal.woff2', 500, 'normal'),
    font('EB Garamond', 'eb-garamond-latin-600-normal.woff2', 600, 'normal'),
    font('EB Garamond', 'eb-garamond-latin-400-italic.woff2', 400, 'italic'),
    font('Figtree', 'figtree-latin-400-normal.woff2', 400, 'normal'),
    font('Figtree', 'figtree-latin-500-normal.woff2', 500, 'normal'),
  ])
).join('\n')

/** The transparent mark (`LogoMark`), ink and accent. */
const MARK = `<svg width="60" height="60" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <path d="M7 13c8 0 10 11 17 11s9 11 17 11" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>
  <path d="M7 35c8 0 10-11 17-11s9-11 17-11" stroke="${ACCENT}" stroke-width="3.4" stroke-linecap="round"/>
</svg>`

const escapeText = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

function card(locale: UiLocale, words: { hero: string; description: string }) {
  // The catalogue's `<em>` is the accent, as the front page draws it.
  const hero = escapeText(words.hero)
    .replaceAll('&#60;em&#62;', '<em>')
    .replaceAll('&#60;/em&#62;', '</em>')
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>
${faces}
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: ${PAPER}; color: ${INK}; overflow: hidden;
  font-synthesis-style: none; }
.card { box-sizing: border-box; width: 1200px; height: 630px; padding: 72px 88px 64px;
  display: flex; flex-direction: column; }
.lockup { display: flex; align-items: center; gap: 14px; font-family: ${SERIF[locale]};
  font-size: 58px; font-weight: 600; letter-spacing: -0.01em; line-height: 1; }
h1 { margin: auto 0 0; max-width: 1000px; font-family: ${SERIF[locale]}; font-weight: 500;
  font-size: 84px; line-height: 1.02; letter-spacing: -0.025em; text-wrap: balance; }
em { font-style: italic; font-weight: 400; color: ${ACCENT}; }
p { margin: 28px 0 0; max-width: 920px; font-family: ${SANS[locale]}; font-size: 28px;
  line-height: 1.45; color: ${INK_2}; text-wrap: pretty; }
.foot { margin-top: 36px; display: flex; justify-content: space-between; align-items: center;
  font-family: ${SANS[locale]}; font-size: 22px; font-weight: 500; color: ${INK_2};
  border-top: 1.5px solid color-mix(in oklab, ${INK} 14%, ${PAPER}); padding-top: 22px; }
</style></head><body><div class="card">
  <div class="lockup">${MARK}<span>Tela</span></div>
  <h1>${hero}</h1>
  <p>${escapeText(words.description)}</p>
  <div class="foot"><span>telaread.com</span></div>
</div></body></html>`
}

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
for (const locale of UI_LOCALES) {
  const messages = JSON.parse(await readFile(join(APP, 'messages', `${locale}.json`), 'utf8')) as {
    front: { heroPlain: string; description: string }
  }
  await page.setContent(
    card(locale, { hero: messages.front.heroPlain, description: messages.front.description }),
  )
  await page.evaluate(() => document.fonts.ready)
  await writeFile(join(OUT, `${locale}.png`), await page.screenshot({ type: 'png' }))
}
await browser.close()
console.log(`wrote ${UI_LOCALES.map((l) => `og/${l}.png`).join(', ')}`)
