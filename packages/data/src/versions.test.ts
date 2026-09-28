import { describe, expect, test } from 'bun:test'
import { chooseCurrent, type VersionSummary, wantsExtraction } from './versions'

const feed = (version: number, bodyChars: number): VersionSummary => ({
  version,
  provenance: 'feed',
  contentKey: `f${version}`,
  bodyChars,
})
const extracted = (version: number, bodyChars: number): VersionSummary => ({
  version,
  provenance: 'readability',
  contentKey: `r${version}`,
  bodyChars,
})

describe('chooseCurrent', () => {
  test('a summary feed keeps its extraction current when the summary changes afterwards', () => {
    // The production regression: v1 summary, v2 extraction, v3 an edited summary.
    const versions = [feed(1, 300), extracted(2, 9000), feed(3, 320)]
    expect(chooseCurrent(versions, 'summary')?.contentKey).toBe('r2')
  })

  test('a full-content feed always shows its latest feed version', () => {
    expect(
      chooseCurrent([feed(1, 5000), extracted(2, 9000), feed(3, 5100)], 'full')?.contentKey,
    ).toBe('f3')
  })

  test('an unknown feed takes the extraction only when it is clearly longer', () => {
    expect(chooseCurrent([feed(1, 1000), extracted(2, 1100)], 'unknown')?.contentKey).toBe('f1')
    expect(chooseCurrent([feed(1, 1000), extracted(2, 1200)], 'unknown')?.contentKey).toBe('r2')
  })

  test('falls back to whichever kind exists', () => {
    expect(chooseCurrent([feed(1, 10)], 'summary')?.contentKey).toBe('f1')
    expect(chooseCurrent([], 'full')).toBeUndefined()
  })
})

describe('wantsExtraction', () => {
  test('a summary feed wants extraction for a new summary, and not after it is extracted', () => {
    expect(wantsExtraction([feed(1, 300)], 'summary', 600)).toBe(true)
    expect(wantsExtraction([feed(1, 300), extracted(2, 9000)], 'summary', 600)).toBe(false)
  })

  test('a changed summary after an extraction wants extracting again', () => {
    expect(wantsExtraction([feed(1, 300), extracted(2, 9000), feed(3, 320)], 'summary', 600)).toBe(
      true,
    )
  })

  test('an unknown feed wants it for a summary-sized body only; a full feed never does', () => {
    expect(wantsExtraction([feed(1, 300)], 'unknown', 600)).toBe(true)
    expect(wantsExtraction([feed(1, 3000)], 'unknown', 600)).toBe(false)
    expect(wantsExtraction([feed(1, 300)], 'full', 600)).toBe(false)
  })
})
