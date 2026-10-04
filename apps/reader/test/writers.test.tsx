/**
 * For writers: the handle offered as a writer types, the card drawn beside the form, and the card
 * carried through signing in (`lib/claim-card.ts`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { blogNameOf, WriterCard } from '../src/components/writer-card'
import { I18n } from '../src/i18n'
import { claimPath, finishCard, isProvisional, keepClaim, takeClaim } from '../src/lib/claim-card'
import { SAMPLE } from '../src/lib/sample-card'
import { blogHost, blogUrl, foldName, suggestHandle } from '../src/lib/suggest-handle'
import { availabilityOf } from '../src/pages/writers'

describe('suggestHandle', () => {
  test('takes the first name, folded to what a handle holds', () => {
    expect(suggestHandle('Ada Lovelace', '')).toBe('ada')
    expect(suggestHandle('José Núñez', '')).toBe('jose')
    expect(suggestHandle('Łukasz Nowak', 'lukasz.dev')).toBe('lukasz')
    expect(suggestHandle('Søren Kierkegaard', '')).toBe('soren')
    expect(suggestHandle('Jean-Luc Picard', '')).toBe('jeanluc')
    expect(suggestHandle("  Seán O'Brien ", '')).toBe('sean')
    expect(foldName('Ærø Straße')).toBe('aero strasse')
  })

  test('a first name too short to be a handle takes the whole name', () => {
    expect(suggestHandle('Li Wei', '')).toBe('li_wei')
    expect(suggestHandle('Al', 'alwrites.example')).toBe('alwrites')
  })

  test("a name with nothing Latin in it takes the blog's own name", () => {
    expect(suggestHandle('胡涂说', 'hutusi.com')).toBe('hutusi')
    expect(suggestHandle('胡涂说', 'https://www.hutusi.com/about')).toBe('hutusi')
    expect(suggestHandle('山田太郎', 'blog.yamada.jp')).toBe('yamada')
    expect(suggestHandle('김민준', 'min-jun.github.io')).toBe('min_jun')
    expect(suggestHandle('', 'jvns.ca')).toBe('jvns')
    // A label that names a language or region edition is no one's name.
    expect(suggestHandle('胡涂说', 'tw.hutusi.com')).toBe('hutusi')
    expect(suggestHandle('', 'fr.example.org')).toBe('example')
  })

  test('suggests nothing it could not use', () => {
    expect(suggestHandle('胡涂说', '')).toBeNull()
    expect(suggestHandle('', '')).toBeNull()
    expect(suggestHandle('Al', '')).toBeNull()
    // `/@about` is a page, not a person.
    expect(suggestHandle('About Me', '')).toBe('about_me')
    expect(suggestHandle('Admin', '')).toBeNull()
    expect(suggestHandle('Bartholomew'.repeat(4), '')).toHaveLength(30)
  })

  test("a blog's address as typed", () => {
    expect(blogUrl(' yourblog.com ')).toBe('https://yourblog.com')
    expect(blogUrl('http://old.example/feed')).toBe('http://old.example/feed')
    expect(blogUrl('')).toBe('')
    expect(blogHost('www.Example.com/posts')).toBe('example.com')
  })
})

describe('whether a handle is free', () => {
  test('reads what tela-api says, and nothing else as a verdict', () => {
    expect(availabilityOf({ status: 'taken', suggestion: 'ada_2' }, 'ada')).toEqual({
      handle: 'ada',
      status: 'taken',
      suggestion: 'ada_2',
    })
    expect(availabilityOf({ status: 'available', suggestion: null }, 'ada')?.status).toBe(
      'available',
    )
    // A suggestion that is no handle is not offered.
    expect(availabilityOf({ status: 'taken', suggestion: '<b>x</b>' }, 'ada')?.suggestion).toBe(
      null,
    )
    expect(availabilityOf({ status: 'maybe' }, 'ada')).toBeNull()
    expect(availabilityOf(null, 'ada')).toBeNull()
  })
})

function render(node: React.ReactNode, locale: UiLocale = 'en'): string {
  return renderToString(
    <I18n locale={locale}>
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  )
}

describe('the writer card', () => {
  test('is the sample until the visitor types: blog, bio, counts, latest and reads', () => {
    const html = render(<WriterCard draft={null} sample={SAMPLE} />)
    expect(html).toContain('data-card="sample"')
    expect(html).toContain('Lucía Ferrer')
    expect(html).toContain('@lucia')
    expect(html).toContain('Kilómetro Cero')
    expect(html).toContain('kilometrocero.blog')
    expect(html).toContain(SAMPLE.bio)
    expect(html).toMatch(/<b[^>]*>48<\/b> followers/)
    expect(html).toMatch(/<b[^>]*>23<\/b> recommendations/)
    expect(html).toMatch(/Reads <b[^>]*>24<\/b> blogs/)
    expect(html).toContain('A kitchen you can take with you')
    expect(html).toContain(SAMPLE.latest.note)
    for (const blog of SAMPLE.reads) expect(html).toContain(blog.name)
    expect(html).toContain('+20')
  })

  test('links nowhere: the sample is no one, and its handle may be someone one day', () => {
    const html = render(<WriterCard draft={null} sample={SAMPLE} />)
    expect(html).not.toContain('<a ')
    // The Follow pill is drawn, not a control.
    expect(html).toMatch(/<span aria-hidden="true"[^>]*data-testid="writer-card-follow"/)
  })

  test("shows a title in the reader's language, and a bio and a note as written", () => {
    const html = render(<WriterCard draft={null} sample={SAMPLE} />, 'zh-Hans')
    expect(html).toContain('一间可以带着走的厨房')
    expect(html).not.toContain('A kitchen you can take with you')
    expect(html).toContain(SAMPLE.bio)
    expect(html).toContain(SAMPLE.latest.note)
  })

  test('names a blog from its host until it has its own name', () => {
    expect(blogNameOf('ada-writes.dev')).toBe('Ada Writes')
    expect(blogNameOf('hutusi.e2e.test')).toBe('Hutusi E2e')
    expect(blogNameOf('localhost')).toBe('Localhost')
  })

  test("is the visitor's own as they type, over the sample", () => {
    const html = render(
      <WriterCard
        draft={{ name: 'Ada Lovelace', handle: 'ada', host: 'ada.dev' }}
        sample={SAMPLE}
      />,
    )
    expect(html).toContain('data-card="draft"')
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('@ada')
    expect(html).toContain('ada.dev')
    expect(html).toContain('data-testid="writer-card-later"')
    expect(html).not.toContain('Lucía Ferrer')
  })

  // A handle can be thirty characters with nowhere to break: both cards cut it inside its column,
  // and keep the whole of it in the title (Codex review, PR #25). The layout itself is held by
  // writers.e2e.ts at 360px; this keeps the sample card, whose handle is short, from losing it.
  test('cuts a long handle in its column on both cards, keeping the whole of it', () => {
    const long = 'alexanderthegreatofmacedon'
    const handleOf = (html: string) =>
      html.match(/<span[^>]*data-testid="writer-card-handle"[^>]*>/)?.[0] ?? ''
    const sample = handleOf(
      render(
        <WriterCard
          draft={null}
          sample={{ ...SAMPLE, writer: { ...SAMPLE.writer, handle: long } }}
        />,
      ),
    )
    const draft = handleOf(
      render(<WriterCard draft={{ name: 'Alexander', handle: long, host: '' }} sample={SAMPLE} />),
    )
    for (const span of [sample, draft]) {
      expect(span).toContain('truncate')
      expect(span).toContain(`title="@${long}"`)
    }
  })
})

describe("the sample's Following", () => {
  test('is newest first, as the Following page is', () => {
    const ago = SAMPLE.activity.map((a) => a.ago)
    expect(ago).toEqual([...ago].sort((x, y) => x - y))
  })

  test('is only the kinds of row Following has, and a note only on a recommendation', () => {
    for (const a of SAMPLE.activity) {
      expect(['recommended', 'liked', 'subscribed']).toContain(a.kind)
      if (a.note) expect(a.kind).toBe('recommended')
      // A subscription names a blog; a like or a recommendation, a post.
      expect(a.post === null).toBe(a.kind === 'subscribed')
    }
  })

  test("agrees with the card: the writer's latest recommendation is in it, with its note", () => {
    const own = SAMPLE.activity.find((a) => a.who.handle === SAMPLE.writer.handle)
    expect(own?.post).toBe(SAMPLE.latest.post)
    expect(own?.note).toBe(SAMPLE.latest.note)
  })
})

describe('the card through signing in', () => {
  const saved = { sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch }
  const held = new Map<string, string>()
  beforeAll(() => {
    Object.assign(globalThis, {
      sessionStorage: {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: (k: string, v: string) => void held.set(k, v),
        removeItem: (k: string) => void held.delete(k),
      },
    })
  })
  afterEach(() => {
    held.clear()
    globalThis.fetch = saved.fetch
  })
  afterAll(() => {
    Object.assign(globalThis, saved)
  })

  test('lands on the claim, saying when the handle was taken', () => {
    expect(claimPath('https://ada.dev')).toBe('/claim?url=https%3A%2F%2Fada.dev')
    expect(claimPath('https://ada.dev', true)).toBe('/claim?url=https%3A%2F%2Fada.dev&taken=1')
    expect(claimPath('')).toBe('/claim')
    expect(isProvisional('u_0123456789')).toBe(true)
    expect(isProvisional('u_ada')).toBe(false)
    expect(isProvisional(null)).toBe(false)
  })

  test('is kept for the tab once, and not past an hour', () => {
    const card = { handle: 'ada', name: 'Ada', url: 'https://ada.dev' }
    keepClaim(card)
    expect(takeClaim()).toEqual(card)
    expect(takeClaim()).toBeNull()
    keepClaim(card)
    expect(takeClaim(Date.now() + 61 * 60 * 1000)).toBeNull()
  })

  /** tela-api as the card meets it: /me names `handle`, and the profile answers `put`. */
  function api(handle: string, put: (body: Record<string, unknown>) => number) {
    const puts: Record<string, unknown>[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/me') {
        return Response.json({ id: 'u9', email: 'ada@example.com', profile: { handle } })
      }
      if (path === '/api/v1/profile' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        puts.push(body)
        const status = put(body)
        return Response.json(status === 200 ? { ok: true } : { error: 'handle_taken' }, {
          status,
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    return puts
  }

  test("gives a new member the card's handle and name", async () => {
    const puts = api('u_0123456789', () => 200)
    const to = await finishCard({ handle: 'ada', name: ' Ada Lovelace ', url: 'https://ada.dev' })
    expect(to).toBe('/claim?url=https%3A%2F%2Fada.dev')
    expect(puts).toEqual([{ handle: 'ada', displayName: 'Ada Lovelace' }])
  })

  test('a handle someone else holds still sets the name, and the claim says so', async () => {
    const puts = api('u_0123456789', (body) => (body.handle ? 409 : 200))
    const to = await finishCard({ handle: 'ada', name: 'Ada', url: 'https://ada.dev' })
    expect(to).toBe('/claim?url=https%3A%2F%2Fada.dev&taken=1')
    expect(puts).toEqual([{ handle: 'ada', displayName: 'Ada' }, { displayName: 'Ada' }])
  })

  test('a handle the server refuses still sets the name, and is not called taken', async () => {
    const puts = api('u_0123456789', (body) => (body.handle ? 400 : 200))
    const to = await finishCard({ handle: 'admin', name: 'Ada', url: 'https://ada.dev' })
    expect(to).toBe('/claim?url=https%3A%2F%2Fada.dev')
    expect(puts).toEqual([{ handle: 'admin', displayName: 'Ada' }, { displayName: 'Ada' }])
  })

  test('a member who chose their handle keeps it', async () => {
    const puts = api('ada_lovelace', () => 200)
    const to = await finishCard({ handle: 'ada', name: 'Ada', url: 'https://ada.dev' })
    expect(to).toBe('/claim?url=https%3A%2F%2Fada.dev')
    expect(puts).toEqual([])
  })
})
