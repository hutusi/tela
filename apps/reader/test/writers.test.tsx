/**
 * For writers: the handle offered as a writer types, the card drawn beside the form, and the card
 * carried through signing in (`lib/claim-card.ts`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { blogNameOf, WriterCard } from '../src/components/writer-card'
import { I18n } from '../src/i18n'
import { claimPath, finishCard, isProvisional, keepClaim, takeClaim } from '../src/lib/claim-card'
import { blogHost, blogUrl, foldName, suggestHandle } from '../src/lib/suggest-handle'
import { activityOf, availabilityOf } from '../src/pages/writers'
import type { ProfileData } from '../src/views/types'

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

const reading = { lang: 'en', never: [] }

function render(node: React.ReactNode): string {
  return renderToString(
    <I18n locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  )
}

const PROFILE: ProfileData = {
  profile: {
    id: 'u1',
    handle: 'hutusi',
    displayName: 'Hu Tusi',
    bio: 'Writes about reading.',
    avatar: null,
    memberSince: 0,
  },
  counts: {
    following: 2,
    followers: 7,
    recommendations: 1,
    liked: null,
    subscriptions: 12,
  },
  blogs: [{ id: 3, title: 'Hutusi', homeUrl: 'https://hutusi.com', faviconKey: null }],
  recommendations: [
    {
      siteId: 4,
      siteTitle: 'Julia Evans',
      homeUrl: 'https://jvns.ca',
      listed: true,
      note: 'Read this one slowly.',
      createdAt: 0,
      article: {
        id: 9,
        feedId: 4,
        title: 'A post worth reading',
      } as ProfileData['recommendations'][number]['article'],
    },
  ],
  subscriptions: [],
  liked: null,
}

describe('the writer card', () => {
  test('is an empty outline with no example and nothing typed', () => {
    const html = render(<WriterCard draft={null} example={null} reading={reading} />)
    expect(html).toContain('data-testid="writer-card-outline"')
    expect(html).not.toContain('data-testid="writer-card"')
  })

  test("is the example's live card: blogs, bio, counts and latest recommendation", () => {
    const html = render(<WriterCard draft={null} example={PROFILE} reading={reading} />)
    expect(html).toContain('data-card="example"')
    expect(html).toContain('Hu Tusi')
    expect(html).toContain('@hutusi')
    expect(html).toContain('Writes about reading.')
    expect(html).toContain('Read this one slowly.')
    expect(html).toContain('A post worth reading')
    expect(html).toContain('data-testid="writer-card-reads"')
    // Whom they read is shown only when they show it.
    const hidden = render(
      <WriterCard draft={null} example={{ ...PROFILE, subscriptions: null }} reading={reading} />,
    )
    expect(hidden).not.toContain('data-testid="writer-card-reads"')
  })

  test('names a blog from its host until it has its own name', () => {
    expect(blogNameOf('ada-writes.dev')).toBe('Ada Writes')
    expect(blogNameOf('hutusi.e2e.test')).toBe('Hutusi E2e')
    expect(blogNameOf('localhost')).toBe('Localhost')
  })

  test("is the visitor's own as they type, over the example", () => {
    const html = render(
      <WriterCard
        draft={{ name: 'Ada Lovelace', handle: 'ada', host: 'ada.dev' }}
        example={PROFILE}
        reading={reading}
      />,
    )
    expect(html).toContain('data-card="draft"')
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('@ada')
    expect(html).toContain('ada.dev')
    expect(html).toContain('data-testid="writer-card-later"')
    expect(html).not.toContain('Hu Tusi')
  })

  // A handle can be thirty characters with nowhere to break: both cards cut it inside its column,
  // and keep the whole of it in the title (Codex review, PR #25). The layout itself is held by
  // writers.e2e.ts at 360px; this keeps the example card, whose live handle is short, from losing it.
  test('cuts a long handle in its column on both cards, keeping the whole of it', () => {
    const long = 'alexanderthegreatofmacedon'
    const handleOf = (html: string) =>
      html.match(/<span[^>]*data-testid="writer-card-handle"[^>]*>/)?.[0] ?? ''
    const example = handleOf(
      render(
        <WriterCard
          draft={null}
          example={{ ...PROFILE, profile: { ...PROFILE.profile, handle: long } }}
          reading={reading}
        />,
      ),
    )
    const draft = handleOf(
      render(
        <WriterCard
          draft={{ name: 'Alexander', handle: long, host: '' }}
          example={null}
          reading={reading}
        />,
      ),
    )
    for (const span of [example, draft]) {
      expect(span).toContain('truncate')
      expect(span).toContain(`title="@${long}"`)
    }
  })
})

describe("the example's activity", () => {
  const post = (id: number) => ({
    ...PROFILE.recommendations[0]!,
    article: { ...PROFILE.recommendations[0]!.article, id },
  })

  test('is its recommendations and public likes, newest first, a post once', () => {
    const data: ProfileData = {
      ...PROFILE,
      recommendations: [
        { ...post(1), note: 'Slowly.', createdAt: 300 },
        { ...post(2), note: null, createdAt: 100 },
      ],
      liked: [
        { ...post(3), likedAt: 200 },
        // Liked and recommended: the recommendation says it.
        { ...post(1), likedAt: 400 },
      ],
    }
    expect(activityOf(data).map((a) => [a.kind, a.post.article.id, a.note])).toEqual([
      ['recommended', 1, 'Slowly.'],
      ['liked', 3, null],
      ['recommended', 2, null],
    ])
  })

  test('is at most four, and nothing without likes shown or recommendations', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...post(i), note: null, createdAt: i }))
    expect(activityOf({ ...PROFILE, recommendations: many })).toHaveLength(4)
    expect(activityOf({ ...PROFILE, recommendations: [], liked: null })).toEqual([])
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
