/**
 * What a browser tells tela-api when something breaks (`src/lib/report.ts`): Tela's own errors
 * only, each once, five a page load at most, never a query string; and what the page shows when
 * the app itself fails (`components/error-boundary.tsx`).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppFailed } from '../src/components/error-boundary'
import {
  type ClientReport,
  ours,
  REPORTS_PER_LOAD,
  reporter,
  watchErrors,
  withoutQueries,
} from '../src/lib/report'

const ORIGIN = 'https://telaread.com'

/** An error thrown from the built app, its stack through `/assets/`. */
function appError(message: string, frame = 'Reader') {
  const err = new TypeError(message)
  err.stack = `TypeError: ${message}\n    at ${frame} (${ORIGIN}/assets/index-abc.js:1:2345)`
  return err
}

function collect() {
  const sent: ClientReport[] = []
  return {
    sent,
    report: reporter(
      (body) => sent.push(body),
      () => '/reading',
    ),
  }
}

describe('a page load reports', () => {
  test('each error once, and five at most', () => {
    const { sent, report } = collect()
    report('boundary', appError('a'))
    report('boundary', appError('a'))
    for (let i = 0; i < 10; i++) report('error', appError(`m${i}`))
    expect(sent).toHaveLength(REPORTS_PER_LOAD)
    expect(sent[0]).toMatchObject({ kind: 'boundary', message: 'TypeError: a', path: '/reading' })
    expect(sent[0]?.stack).toContain('/assets/index-abc.js')
  })

  test('no query string, in the message or the stack', () => {
    const { sent, report } = collect()
    const err = new Error('could not load /join?code=SECRET')
    err.stack = `Error: could not load /join?code=SECRET\n    at x (${ORIGIN}/assets/a.js?v=SECRET:1:1)`
    report('rejection', err)
    expect(JSON.stringify(sent)).not.toContain('SECRET')
    expect(withoutQueries('/l/abc?x=1#top')).toBe('/l/abc#top')
  })

  test("only Tela's own errors, built or under Vite", () => {
    expect(ours(`at f (${ORIGIN}/assets/index-abc.js:1:2)`, ORIGIN)).toBe(true)
    expect(ours(`at f (${ORIGIN}/src/pages/reading.tsx:10:2)`, ORIGIN)).toBe(true)
    expect(ours('at f (chrome-extension://abc/content.js:1:2)', ORIGIN)).toBe(false)
    expect(ours('at f (https://elsewhere.example/assets/x.js:1:2)', ORIGIN)).toBe(false)
    expect(ours(undefined, ORIGIN)).toBe(false)
  })
})

describe('the page-wide listeners', () => {
  function page() {
    const target = Object.assign(new EventTarget(), {
      location: { origin: ORIGIN },
      document: new EventTarget(),
    })
    const told: [string, unknown][] = []
    watchErrors(target as unknown as Window, (kind, error) => told.push([kind, error]))
    const fire = (on: EventTarget, type: string, fields: object) =>
      on.dispatchEvent(Object.assign(new Event(type), fields))
    return { target, told, fire }
  }

  test("tell an unhandled error or rejection of Tela's, and nobody else's", () => {
    const { target, told, fire } = page()
    fire(target, 'error', { error: appError('boom') })
    fire(target, 'error', { error: null, message: 'Script error.' })
    const foreign = new Error('extension')
    foreign.stack = 'Error: extension\n    at x (chrome-extension://abc/x.js:1:1)'
    fire(target, 'error', { error: foreign })
    fire(target, 'unhandledrejection', { reason: appError('rejected') })
    // An aborted fetch rejects with a DOMException that ran through no script of Tela's.
    fire(target, 'unhandledrejection', { reason: new DOMException('aborted', 'AbortError') })
    expect(told.map(([kind]) => kind)).toEqual(['error', 'rejection'])
  })

  test('tell a policy violation by its directive and address, without the query', () => {
    const { target, told, fire } = page()
    fire(target.document, 'securitypolicyviolation', {
      effectiveDirective: 'img-src',
      blockedURI: 'https://tracker.example/p.gif?id=SECRET',
    })
    expect(told).toEqual([['csp', 'img-src https://tracker.example/p.gif']])
  })
})

describe("the app's failure", () => {
  test('is worded from the catalogues, with no provider to ask', () => {
    const zh = renderToStaticMarkup(createElement(AppFailed, { locale: 'zh-Hans' }))
    expect(zh).toContain('加载时出错了。')
    expect(zh).toContain('重试')
    const en = renderToStaticMarkup(createElement(AppFailed, { locale: 'en' }))
    expect(en).toContain('Something went wrong loading this.')
    expect(en).toContain('Try again')
  })
})
