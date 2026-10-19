import { describe, expect, test } from 'bun:test'
import { type BlockPair, translatedPrefix } from '../src/lib/block-pairs'
import {
  FINISHED_RETRY_MS,
  finishedObject,
  type Live,
  moreAdvanced,
  pollDelay,
  pullsAfterRequest,
  readerState,
} from '../src/lib/use-translation'
import type { TranslationObject } from '../src/store/objects'

const at = (state: string, chunks: number): Live => ({
  state,
  chunkKeys: Array.from({ length: chunks }, (_, i) => `tc/k/en/r/${i}.json`),
  objectKey: null,
  failedLeaves: [],
})

describe('what an open article shows of its translation', () => {
  test('a later state wins, whichever side it comes from', () => {
    expect(moreAdvanced(at('requested', 0), at('running', 1))?.state).toBe('running')
    expect(moreAdvanced(at('done', 4), at('running', 3))?.state).toBe('done')
    expect(moreAdvanced(undefined, at('running', 1))?.state).toBe('running')
  })

  test('while both run, the chunks polling has seen are not held back by the last pull', () => {
    // A pull a minute ago said running with two chunks; polling now sees five.
    expect(moreAdvanced(at('running', 2), at('running', 5))?.chunkKeys).toHaveLength(5)
    expect(moreAdvanced(at('running', 5), at('running', 2))?.chunkKeys).toHaveLength(5)
  })

  test('between two finished answers, the synced row stands', () => {
    expect(moreAdvanced(at('done', 3), at('partial', 4))?.state).toBe('done')
  })
})

describe('what Translation mode shows of a translation still arriving', () => {
  const pair = (id: string, pending = false): BlockPair => ({
    id,
    tag: 'p',
    translated: pending ? `<p>${id}</p>` : `<p>en: ${id}</p>`,
    original: `<p>${id}</p>`,
    untranslated: pending,
    pending,
  })

  test('the blocks before the first one still on its way, and a placeholder for the rest', () => {
    const pairs = [pair('a'), pair('b'), pair('c', true), pair('d', true)]
    const shown = translatedPrefix(pairs, 'running')
    expect(shown.pairs.map((p) => p.id)).toEqual(['a', 'b'])
    expect(shown.rest).toBe(true)
  })

  test('a block after a gap waits for the gap, so nothing reads as following on from it', () => {
    // The third chunk landed before the second, whose fetch failed or is still out.
    const pairs = [pair('a'), pair('b', true), pair('c'), pair('d')]
    const shown = translatedPrefix(pairs, 'done')
    expect(shown.pairs.map((p) => p.id)).toEqual(['a'])
    expect(shown.rest).toBe(true)
  })

  test('nothing more comes once it failed: what never came shows as not translated', () => {
    const pairs = [pair('a'), pair('b', true), pair('c')]
    const shown = translatedPrefix(pairs, 'failed')
    expect(shown.rest).toBe(false)
    expect(shown.pairs.map((p) => [p.id, p.untranslated, p.pending])).toEqual([
      ['a', false, false],
      ['b', true, false],
      ['c', false, false],
    ])
  })

  test('with nothing pending, the pairs are shown as they are', () => {
    const pairs = [pair('a'), { ...pair('b'), untranslated: true }]
    for (const state of ['done', 'partial', 'failed', 'running'] as const) {
      const shown = translatedPrefix(pairs, state)
      expect(shown.pairs).toBe(pairs)
      expect(shown.rest).toBe(false)
    }
  })
})

describe('a finished translation object that cannot be had', () => {
  const FINISHED: TranslationObject = {
    format: 1,
    lang: 'en',
    status: 'done',
    blocks: ['<p>en: a</p>'],
    failedLeaves: [],
  }
  /** Objects that give each answer in turn: an object, null (a non-OK answer) or a rejection. */
  const answering = (...answers: (TranslationObject | null | Error)[]) => {
    const asked: string[] = []
    const objects = {
      object: async <T>(key: string) => {
        asked.push(key)
        const answer = answers.shift() ?? null
        if (answer instanceof Error) throw answer
        return answer as T | null
      },
    }
    return { objects, asked }
  }
  const pauses: number[] = []
  const pause = async (ms: number) => {
    pauses.push(ms)
  }

  test('is asked for once more after a pause, and kept when the second answer is it', async () => {
    pauses.length = 0
    const { objects, asked } = answering(null, FINISHED)
    const got = await finishedObject(objects, 't/k/en/1.json', new AbortController().signal, pause)
    expect(got).toBe(FINISHED)
    expect(asked).toEqual(['t/k/en/1.json', 't/k/en/1.json'])
    expect(pauses).toEqual([FINISHED_RETRY_MS])
  })

  test('is given up after the second, a network error read as no answer', async () => {
    const { objects, asked } = answering(new TypeError('Failed to fetch'), null)
    const got = await finishedObject(objects, 't/k/en/1.json', new AbortController().signal, pause)
    expect(got).toBeNull()
    expect(asked).toHaveLength(2)
  })

  test('is asked for once when the first answer is it, and not again once nobody waits', async () => {
    const once = answering(FINISHED)
    expect(await finishedObject(once.objects, 'k', new AbortController().signal, pause)).toBe(
      FINISHED,
    )
    expect(once.asked).toHaveLength(1)

    const controller = new AbortController()
    const gone = answering(null, FINISHED)
    const got = await finishedObject(gone.objects, 'k', controller.signal, async () => {
      controller.abort()
    })
    expect(got).toBeNull()
    expect(gone.asked).toHaveLength(1)
  })

  test('leaves blocks still waiting failed, for this reader, so Retry is offered', () => {
    const done: Live = {
      state: 'done',
      chunkKeys: [],
      objectKey: 't/k/en/1.json',
      failedLeaves: [],
    }
    expect(readerState(done, true, false)).toBe('done')
    expect(readerState(done, true, true)).toBe('failed')
    expect(readerState({ ...done, state: 'partial' }, true, true)).toBe('failed')
    // Not asked for yet, nothing is under way for this member, stalled or not.
    expect(readerState(done, false, true)).toBe('none')
    expect(readerState(null, true, true)).toBe('none')
    expect(readerState({ ...done, state: 'skipped' }, true, false)).toBe('failed')
  })
})

describe('polling a translation under way', () => {
  test('quickly while the first chunk is awaited, for its first five seconds only', () => {
    expect(pollDelay(0, false)).toBe(400)
    expect(pollDelay(4_999, false)).toBe(400)
    // A slow model: back to the usual pace, rather than four times as many asks for all of it.
    expect(pollDelay(5_000, false)).toBe(1_500)
    expect(pollDelay(40_000, false)).toBe(1_500)
    // The first chunk is on screen: the rest comes at the usual pace.
    expect(pollDelay(800, true)).toBe(1_500)
  })
})

describe('what a translation request pulls', () => {
  test('only a translation already done, whose row the device may lack', () => {
    expect(pullsAfterRequest('ready')).toBe(true)
    // The poll follows these and pulls when they end; the pull after the push brings the row.
    for (const status of ['requested', 'in_progress']) expect(pullsAfterRequest(status)).toBe(false)
    // A refusal writes nothing.
    for (const status of ['invalid', 'unavailable', 'rate_limited', 'budget_exhausted']) {
      expect(pullsAfterRequest(status)).toBe(false)
    }
  })
})
