/**
 * The crop dialog's arithmetic (ADR 0033), apart from the DOM so it can be tested: an image of
 * `width` × `height` shown in a square `view`, scaled to cover it at zoom 1, and moved by `x`, `y`
 * (where its top-left corner sits, in view pixels, so both are at most 0).
 */

/** What an upload becomes: a square this many pixels a side. */
export const PICTURE_SIDE = 256
export const MAX_ZOOM = 4

export type Crop = {
  width: number
  height: number
  view: number
  zoom: number
  x: number
  y: number
}

/** The scale at which the image just covers the view: its shorter side fills it. */
export function coverScale(width: number, height: number, view: number): number {
  return view / Math.min(width, height)
}

const scaleOf = (c: Crop) => coverScale(c.width, c.height, c.view) * c.zoom

/** The offset moved back as far as it must go for the image to cover the view. */
export function clampOffset(c: Crop): { x: number; y: number } {
  const s = scaleOf(c)
  const clamp = (v: number, size: number) => Math.min(0, Math.max(c.view - size * s, v))
  return { x: clamp(c.x, c.width), y: clamp(c.y, c.height) }
}

/** The image centred in the view at `zoom`. */
export function centred(width: number, height: number, view: number, zoom = 1): Crop {
  const s = coverScale(width, height, view) * zoom
  return { width, height, view, zoom, x: (view - width * s) / 2, y: (view - height * s) / 2 }
}

/** Zoomed to `zoom` about the view's centre: what is under the centre stays under it. */
export function zoomTo(c: Crop, zoom: number): Crop {
  const next = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const ratio = next / c.zoom
  const half = c.view / 2
  const moved = { ...c, zoom: next, x: half - (half - c.x) * ratio, y: half - (half - c.y) * ratio }
  return { ...moved, ...clampOffset(moved) }
}

/** Moved by `dx`, `dy` view pixels, as far as the image still covers the view. */
export function moveBy(c: Crop, dx: number, dy: number): Crop {
  const moved = { ...c, x: c.x + dx, y: c.y + dy }
  return { ...moved, ...clampOffset(moved) }
}

/** The square of the image, in its own pixels, that the view shows: what the canvas draws. */
export function cropRect(c: Crop): { sx: number; sy: number; size: number } {
  const s = scaleOf(c)
  const { x, y } = clampOffset(c)
  return { sx: -x / s, sy: -y / s, size: c.view / s }
}
