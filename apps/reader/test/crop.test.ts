import { describe, expect, test } from 'bun:test'
import { centred, clampOffset, cropRect, MAX_ZOOM, moveBy, zoomTo } from '../src/lib/crop'

/** Equal to within a millionth of a pixel: the arithmetic is in floating point. */
function near(got: Record<string, number>, want: Record<string, number>) {
  for (const k of Object.keys(want))
    expect([k, got[k] ?? Number.NaN]).toEqual([k, expect.closeTo(want[k] ?? 0, 6)])
}

describe('the crop arithmetic (ADR 0033)', () => {
  test('a landscape image covers the view at zoom 1, centred, and shows its middle square', () => {
    const c = centred(600, 400, 280)
    near(cropRect(c), { sx: 100, sy: 0, size: 400 })
  })

  test('it moves only as far as the image still covers the view', () => {
    const c = centred(600, 400, 280)
    near(cropRect(moveBy(c, 1000, 0)), { sx: 0, sy: 0, size: 400 })
    near(cropRect(moveBy(c, -1000, 0)), { sx: 200, sy: 0, size: 400 })
    // No room to move vertically at zoom 1: the height just fills the view.
    near(cropRect(moveBy(c, 0, 50)), { sy: 0 })
  })

  test('zooming keeps the centre where it was, and stays within 1 and the most', () => {
    const c = zoomTo(centred(600, 400, 280), 2)
    near(cropRect(c), { sx: 200, sy: 100, size: 200 })
    expect(zoomTo(c, 99).zoom).toBe(MAX_ZOOM)
    expect(zoomTo(c, 0.1).zoom).toBe(1)
  })

  test('zooming out after a move pulls the image back over the view', () => {
    const c = zoomTo(moveBy(zoomTo(centred(400, 400, 280), 3), -10_000, -10_000), 1)
    near(clampOffset(c), { x: 0, y: 0 })
    near(cropRect(c), { sx: 0, sy: 0, size: 400 })
  })
})
