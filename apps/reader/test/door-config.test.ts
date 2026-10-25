/**
 * What the front door offers (ADRs 0036, 0056): the providers and the sign-up switch, asked of
 * tela-api, remembered on the device, and followed at once when a refusal says otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  askDoorConfig,
  doorConfig,
  learnSignup,
  nextUtcMidnight,
  readSignup,
} from '../src/lib/door-config'

const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
const held = new Map<string, string>([
  ['tela.auth-providers', JSON.stringify(['github'])],
  ['tela.signup', JSON.stringify({ mode: 'open', paused: false })],
])
/** What each request asked, and the answers still to give, in order. */
const asked: RequestInit[] = []
const answers: (() => Promise<Response>)[] = []
const json =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    },
    fetch: async (_input: string, init: RequestInit) => {
      asked.push(init)
      const answer = answers.shift()
      if (!answer) throw new Error('no answer left')
      return answer()
    },
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})

describe('the door config', () => {
  test('reads a switch as tela-api words it, and nothing else', () => {
    expect(readSignup({ signup: 'open', paused: true })).toEqual({ mode: 'open', paused: true })
    // Only an open sign-up can be paused.
    expect(readSignup({ signup: 'invite', paused: true })).toEqual({
      mode: 'invite',
      paused: false,
    })
    expect(readSignup({ mode: 'open' })).toEqual({ mode: 'open', paused: false })
    for (const junk of [null, 'open', {}, { signup: 'closed' }, { google: true }])
      expect(readSignup(junk)).toBeNull()
  })

  test('starts from what the device heard, and follows each answer, and each refusal', async () => {
    expect(doorConfig()).toEqual({
      providers: ['github'],
      signup: { mode: 'open', paused: false },
    })
    answers.push(json({ google: true, github: false, signup: 'invite', paused: false }))
    await askDoorConfig()
    expect(doorConfig()).toEqual({
      providers: ['google'],
      signup: { mode: 'invite', paused: false },
    })
    expect(JSON.parse(held.get('tela.signup') ?? 'null')).toEqual({ mode: 'invite', paused: false })
    expect(asked.at(-1)?.cache).toBe('default')

    // A refusal says the day is full while an older answer is on its way: the refusal stands, and
    // the next question asks past the browser's copy.
    let answer = (_: Response) => {}
    answers.push(() => new Promise<Response>((resolve) => (answer = resolve)))
    const asking = askDoorConfig()
    learnSignup({ mode: 'open', paused: true })
    answer(await json({ google: true, github: false, signup: 'open', paused: false })())
    await asking
    expect(doorConfig().signup).toEqual({ mode: 'open', paused: true })
    answers.push(json({ google: true, github: true, signup: 'open', paused: true }))
    await askDoorConfig()
    expect(asked.at(-1)?.cache).toBe('no-cache')
    expect(doorConfig().providers).toEqual(['google', 'github'])

    // A failure keeps what was heard; a tela-api from before the endpoint offers neither provider,
    // and needs a code.
    answers.push(json({ error: 'unavailable' }, 503))
    await askDoorConfig()
    expect(doorConfig().signup).toEqual({ mode: 'open', paused: true })
    answers.push(json({ error: 'not_found' }, 404))
    await askDoorConfig()
    expect(doorConfig()).toEqual({ providers: [], signup: { mode: 'invite', paused: false } })
  })

  test("a day's places come back at the next UTC midnight", () => {
    const at = Date.UTC(2026, 9, 25, 23, 59)
    expect(nextUtcMidnight(at)).toBe(Date.UTC(2026, 9, 26))
    expect(nextUtcMidnight(Date.UTC(2026, 9, 26))).toBe(Date.UTC(2026, 9, 27))
  })
})
