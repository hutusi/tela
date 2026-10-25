/**
 * robots.txt (ADR 0060), read the way RFC 9309 says a crawler reads it: the group that names the
 * crawler, else `*`; within it the longest matching rule, `allow` on a tie; `$` ends a path.
 */
import { describe, expect, test } from 'bun:test'
import { memoryBlobs } from '@tela/platform/portable'
import { createEdge, type PublicPages } from '../worker/edge'
import {
  ANSWER_AGENTS,
  CONTENT_SIGNAL,
  OWN_PAGES,
  robotsTxt,
  TRAINING_AGENTS,
} from '../worker/robots'

const ORIGIN = 'https://telaread.com'

type Group = { agents: string[]; rules: { allow: boolean; path: string }[]; lines: string[] }

function parse(text: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = []
  const sitemaps: string[] = []
  let current: Group | null = null
  let rulesStarted = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const [key = '', ...rest] = line.split(':')
    const field = key.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (field === 'sitemap') {
      sitemaps.push(value)
      continue
    }
    if (field === 'user-agent') {
      if (!current || rulesStarted) {
        current = { agents: [], rules: [], lines: [] }
        groups.push(current)
        rulesStarted = false
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (!current) throw new Error(`a rule before any user-agent: ${line}`)
    rulesStarted = true
    current.lines.push(line)
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value })
    }
  }
  return { groups, sitemaps }
}

/** Whether `agent` may fetch `path`, as RFC 9309 has it. */
function allowed(text: string, agent: string, path: string): boolean {
  const { groups } = parse(text)
  const named = groups.filter((g) => g.agents.includes(agent.toLowerCase()))
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap(
    (g) => g.rules,
  )
  let best: { allow: boolean; length: number } | null = null
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$')
    const body = anchored ? rule.path.slice(0, -1) : rule.path
    const pattern = new RegExp(
      `^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}${anchored ? '$' : ''}`,
    )
    if (!pattern.test(path)) continue
    const length = rule.path.length
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length }
    }
  }
  return best?.allow ?? true
}

/**
 * Whether `agent` may fetch `path` to a parser older than RFC 9309 that takes the first rule in its
 * group that matches, in the file's order: robots.txt must read the same to it.
 */
function allowedFirstMatch(text: string, agent: string, path: string): boolean {
  const { groups } = parse(text)
  const named = groups.filter((g) => g.agents.includes(agent.toLowerCase()))
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap(
    (g) => g.rules,
  )
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$')
    const body = anchored ? rule.path.slice(0, -1) : rule.path
    const pattern = new RegExp(
      `^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}${anchored ? '$' : ''}`,
    )
    if (pattern.test(path)) return rule.allow
  }
  return true
}

const OPEN = robotsTxt({ origin: ORIGIN, noindex: false })

describe('robots.txt', () => {
  test('while TELA_NOINDEX is set, closes everything to everyone', () => {
    const closed = robotsTxt({ origin: ORIGIN, noindex: true })
    expect(closed).toBe('User-agent: *\nDisallow: /\n')
    for (const agent of ['Googlebot', 'OAI-SearchBot', 'GPTBot']) {
      expect(allowed(closed, agent, '/')).toBe(false)
    }
  })

  test('opens every public page to search engines and answer tools, and nothing of the app', () => {
    for (const agent of ['Googlebot', 'Bingbot', 'Baiduspider', ...ANSWER_AGENTS]) {
      for (const path of [
        '/',
        '/?titles=translated',
        '/discover',
        '/discover/articles?sort=new',
        '/s/12',
        '/l/abcdefABCDEF',
        '/l/abcdefABCDEF.rss',
        '/discover.opml',
        '/@ann',
        '/about',
        '/writers',
        '/sitemap.xml',
        '/llms.txt',
      ]) {
        expect([agent, path, allowed(OPEN, agent, path)]).toEqual([agent, path, true])
      }
      for (const path of [
        '/api/v1/public/discover',
        '/o/c/abc.json',
        '/img/abc/0',
        '/avatar/user-1?v=1',
        '/join?code=ABC',
        '/login',
        '/reading?article=1',
        '/settings/profile',
        '/sites/12/claim',
        '/admin',
        '/__tela/shell',
      ]) {
        expect([agent, path, allowed(OPEN, agent, path)]).toEqual([agent, path, false])
      }
    }
  })

  test("keeps training crawlers to Tela's own pages, off everything that shows writers' work", () => {
    for (const agent of TRAINING_AGENTS) {
      for (const path of ['/about', '/privacy', '/terms', '/writers', '/llms.txt']) {
        expect([agent, path, allowed(OPEN, agent, path)]).toEqual([agent, path, true])
      }
      for (const path of [
        // The front page's edition is writers' titles and excerpts.
        '/',
        '/s/12',
        '/l/abcdefABCDEF',
        '/@ann',
        '/discover',
        '/discover/blogs?topic=tech',
        '/discover.opml',
        '/?titles=translated',
        '/api/v1/public/discover',
        '/sitemap.xml',
      ]) {
        expect([agent, path, allowed(OPEN, agent, path)]).toEqual([agent, path, false])
      }
    }
    expect(OWN_PAGES).toContain('/writers')
  })

  test('reads the same to a parser that takes the first matching rule', () => {
    const paths = [
      '/',
      '/?titles=translated',
      '/discover',
      '/s/12',
      '/@ann',
      '/about',
      '/writers',
      '/llms.txt',
      '/sitemap.xml',
      '/api/v1/public/discover',
      '/join?code=ABC',
      '/admin',
      '/__tela/shell',
    ]
    for (const agent of ['Googlebot', ...ANSWER_AGENTS, ...TRAINING_AGENTS]) {
      for (const path of paths) {
        expect([agent, path, allowedFirstMatch(OPEN, agent, path)]).toEqual([
          agent,
          path,
          allowed(OPEN, agent, path),
        ])
      }
    }
    // Allowing everything is the default, and first would allow everything to such a parser.
    expect(OPEN).not.toContain('Allow: /\n')
  })

  test('says the content signals in every group, and where the sitemap is', () => {
    const { groups, sitemaps } = parse(OPEN)
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      expect(group.lines).toContain(`Content-Signal: ${CONTENT_SIGNAL}`)
    }
    expect(CONTENT_SIGNAL).toBe('search=yes, ai-input=yes, ai-train=no')
    expect(sitemaps).toEqual([`${ORIGIN}/sitemap.xml`])
    // Every name a product token: letters, digits, `_` and `-` (RFC 9309).
    for (const agent of [...ANSWER_AGENTS, ...TRAINING_AGENTS]) {
      expect(agent).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  test('is what the edge answers, cached an hour', async () => {
    const edge = (noindex: boolean) =>
      createEdge({
        blobs: memoryBlobs(),
        api: { fetch: async () => new Response('no', { status: 503 }) },
        assets: { fetch: async () => new Response('') },
        pages: {} as PublicPages,
        cache: { match: async () => undefined, put: async () => {} },
        fetchImage: async () => new Response('', { status: 404 }),
        config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex },
      })
    const res = await edge(false).fetch(new Request(`${ORIGIN}/robots.txt`))
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await res.text()).toBe(OPEN)
    const closed = await edge(true).fetch(new Request(`${ORIGIN}/robots.txt`))
    expect(await closed.text()).toBe('User-agent: *\nDisallow: /\n')
  })
})
