#!/usr/bin/env bun
/**
 * Generates the app icons from one description of the tiled Tela mark.
 *
 * The mark has two forms (see docs/DESIGN.md). The transparent one lives in `LogoMark`; this is the
 * tiled one, which exists only where the mark needs a shape of its own. Its strands thicken as the
 * tile shrinks so the crossing stays readable — 3.3 at 32px, 5.0 at 16px — which is the whole reason
 * the raster sizes are drawn separately rather than scaled from one image.
 *
 * There is no SVG rasteriser on a stock macOS, so the PNGs come from the Chromium that Playwright
 * already installs for `bun run e2e`. Run `cd apps/reader && bun run icons` after changing the geometry and commit
 * what it writes; nothing calls this at build time.
 *
 * Output, all under public/, served as static assets and named by index.html:
 *   icon.svg        the tile at the 32px weight — what a browser that accepts an SVG icon uses,
 *                   and 32 device px is what a 16px tab slot asks for on a 2x display
 *   favicon.ico     16 and 32, each at its own weight, for everything that does not
 *   apple-icon.png  180, square-cornered: iOS applies its own mask, and rounding it here first
 *                   would round the corners twice
 *
 * and, named by manifest.webmanifest, for installing Tela on Android and the desktop:
 *   icon-192.png, icon-512.png   the rounded tile, purpose `any`: shown as they are
 *   icon-maskable-512.png        purpose `maskable`: full-bleed and square, since the launcher
 *                                cuts its own shape, with the mark drawn smaller so that the
 *                                tightest of those shapes, the central circle 80% across, still
 *                                leaves it the margin the rounded tile gives it
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const INK = '#1f1c18'
const PAPER = '#f6f2ea'
/** oklch(0.68 0.14 150) — the accent lifted for a dark ground, as the design file specifies. */
const ACCENT_ON_DARK = '#4eb068'

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * The maskable icon's mark, scaled about the tile's centre. Unscaled, its strands reach 18.3 of
 * the viewBox's 48 from the centre (√(14² + 9²), plus half a 3.3 stroke for the round cap): 76% of
 * the way to the rounded tile's edge. At 0.8 they reach 76% of the way to the safe circle's edge
 * (radius 19.2), so a round launcher icon frames the mark as the tile does.
 */
const MASKABLE_SCALE = 0.8
const SAFE_RADIUS = 0.4 * 48

function tile({
  size,
  stroke,
  radius,
  scale = 1,
}: {
  size: number
  stroke: number
  radius: number
  scale?: number
}) {
  const strands = `<path d="M10 15c7 0 9 9 14 9s7 9 14 9" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linecap="round"/>
  <path d="M10 33c7 0 9-9 14-9s7-9 14-9" fill="none" stroke="${ACCENT_ON_DARK}" stroke-width="${stroke}" stroke-linecap="round"/>`
  const mark =
    scale === 1
      ? strands
      : `<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">
  ${strands}
  </g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <title>Tela</title>
  <rect width="48" height="48" rx="${radius}" fill="${INK}"/>
  ${mark}
</svg>
`
}

// A round launcher cuts a maskable icon down to its safe circle: a mark that reached past it
// would lose the ends of its strands.
if ((Math.hypot(14, 9) + 3.3 / 2) * MASKABLE_SCALE > SAFE_RADIUS) {
  throw new Error('the maskable mark leaves the safe zone')
}

/**
 * Packs PNGs into an ICO container: a 6-byte header, one 16-byte directory entry per image, then
 * the payloads. A width or height of 0 means 256, which is why the byte is only ever a size below it.
 */
function ico(images: { size: number; png: Buffer }[]) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, png }, i) => {
    const at = 16 * i
    dir.writeUInt8(size >= 256 ? 0 : size, at)
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

const browser = await chromium.launch()
// As large as the largest icon: a screenshot's clip cannot reach past the viewport.
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })

/**
 * Clipped rather than sized to the viewport: Chromium clamps very small viewports, and 16 is well
 * inside the range where it would.
 */
async function raster(svg: string, size: number) {
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  return await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  })
}

const svg = tile({ size: 48, stroke: 3.3, radius: 11 })
await writeFile(join(APP_DIR, 'icon.svg'), svg)

await writeFile(
  join(APP_DIR, 'favicon.ico'),
  ico([
    { size: 16, png: await raster(tile({ size: 16, stroke: 5, radius: 11 }), 16) },
    { size: 32, png: await raster(tile({ size: 32, stroke: 3.3, radius: 11 }), 32) },
  ]),
)

await writeFile(
  join(APP_DIR, 'apple-icon.png'),
  await raster(tile({ size: 180, stroke: 3.3, radius: 0 }), 180),
)

for (const size of [192, 512]) {
  await writeFile(
    join(APP_DIR, `icon-${size}.png`),
    await raster(tile({ size, stroke: 3.3, radius: 11 }), size),
  )
}

await writeFile(
  join(APP_DIR, 'icon-maskable-512.png'),
  await raster(tile({ size: 512, stroke: 3.3, radius: 0, scale: MASKABLE_SCALE }), 512),
)

await browser.close()
console.log(
  'wrote icon.svg, favicon.ico, apple-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png',
)
