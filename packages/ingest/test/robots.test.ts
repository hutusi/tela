import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allowedBy,
  normalizePath,
  parseRobots,
  patternMatches,
  ROBOTS_MAX_BYTES,
  ROBOTS_TOKEN,
  robotsAllows,
  rulesFor,
  serializeRules,
} from '../src/robots'

const at = (path: string) => `https://blog.example${path}`
const allows = (text: string, path: string) => robotsAllows(text, at(path))

describe('the group Tela follows', () => {
  test("is the one naming Tela, case aside and its version cut off, over everyone's", () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: tela/0.1\nDisallow: /drafts/\n'
    expect(allows(text, '/posts/1')).toBe(true)
    expect(allows(text, '/drafts/1')).toBe(false)
    expect(rulesFor(parseRobots(text))).toEqual({
      agent: 'tela',
      rules: [{ allow: false, path: '/drafts/' }],
    })
    expect(allows('User-Agent: TELA\nDisallow: /x', '/x')).toBe(false)
  })

  test("is everyone's when no group names Tela, and other crawlers' groups are not Tela's", () => {
    const text = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n'
    expect(allows(text, '/')).toBe(true)
    expect(allows(text, '/private/1')).toBe(false)
    // "Telabot" is another crawler, not Tela.
    expect(allows('User-agent: Telabot\nDisallow: /', '/')).toBe(true)
    expect(allows('User-agent: GPTBot\nDisallow: /', '/')).toBe(true)
  })

  test('is every group naming it, as one, and one group may name several agents', () => {
    const text = [
      'User-agent: Tela',
      'Disallow: /a',
      'User-agent: Googlebot',
      'Disallow: /b',
      '',
      'User-agent: bingbot',
      'User-agent: tela',
      'Disallow: /c',
    ].join('\n')
    expect(allows(text, '/a')).toBe(false)
    expect(allows(text, '/b')).toBe(true)
    expect(allows(text, '/c')).toBe(false)
    // An agent line after a rule starts another group: /b was Googlebot's alone.
    expect(parseRobots(text).map((g) => g.agents)).toEqual([
      ['tela'],
      ['googlebot'],
      ['bingbot', 'tela'],
    ])
  })

  test("a group naming Tela with no rules allows everything, whatever everyone's says", () => {
    expect(allows('User-agent: *\nDisallow: /\nUser-agent: Tela\nDisallow:\n', '/x')).toBe(true)
    expect(allows('User-agent: *\nDisallow: /\n\nUser-agent: Tela\n', '/x')).toBe(true)
    // A blank line ends nothing: agent lines with no rule between them are one group.
    expect(allows('User-agent: Tela\n\nUser-agent: *\nDisallow: /\n', '/x')).toBe(false)
  })

  test("an agent no token names still ends the group above it, so its rules are nobody's", () => {
    // Common on Chinese blogs: Tela is under `*`, and 360Spider's `Disallow: /` is not Tela's.
    const chinese = 'User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: 360Spider\nDisallow: /\n'
    expect(allows(chinese, '/2026/10/post')).toBe(true)
    expect(allows(chinese, '/wp-admin/x')).toBe(false)
    // An empty agent line ends the group the same way.
    expect(allows('User-agent: *\nAllow: /\n\nUser-agent:\nDisallow: /\n', '/a')).toBe(true)
    // And beside a token it names nothing more: the `*` in that group still applies.
    expect(allows('User-agent: 360Spider\nUser-agent: *\nDisallow: /p\n', '/p')).toBe(false)
  })

  test('no group, an empty file, or rules outside any group allow everything', () => {
    expect(allows('', '/x')).toBe(true)
    expect(allows('Disallow: /\n', '/x')).toBe(true)
    expect(allows('Sitemap: https://blog.example/sitemap.xml\n', '/x')).toBe(true)
    expect(allows('<!doctype html><html><body>Not found</body></html>', '/x')).toBe(true)
  })
})

describe('which rule decides', () => {
  test('the longest matching pattern, and Allow on a tie (RFC 9309, 2.2.2)', () => {
    expect(allows('User-agent: *\nAllow: /p\nDisallow: /', '/page')).toBe(true)
    expect(allows('User-agent: *\nAllow: /folder\nDisallow: /folder', '/folder/page')).toBe(true)
    expect(allows('User-agent: *\nDisallow: /folder\nAllow: /folder', '/folder/page')).toBe(true)
    expect(allows('User-agent: *\nAllow: /page\nDisallow: /*.html', '/page.html')).toBe(false)
    expect(allows('User-agent: *\nAllow: /$\nDisallow: /', '/')).toBe(true)
    expect(allows('User-agent: *\nAllow: /$\nDisallow: /', '/page.htm')).toBe(false)
    expect(
      allows('User-agent: *\nDisallow: /private\nAllow: /private/open', '/private/open/1'),
    ).toBe(true)
  })

  test('a path no rule matches is allowed, and robots.txt itself always is', () => {
    expect(allows('User-agent: *\nDisallow: /private', '/public')).toBe(true)
    expect(allows('User-agent: *\nDisallow: /', '/robots.txt')).toBe(true)
  })

  test('rules match the query string too', () => {
    const text = 'User-agent: *\nDisallow: /*?replytocom=\nDisallow: /search?'
    expect(allows(text, '/post?replytocom=12')).toBe(false)
    expect(allows(text, '/post?page=2')).toBe(true)
    expect(allows(text, '/search?q=tea')).toBe(false)
    expect(allows(text, '/search')).toBe(true)
  })
})

describe('patterns', () => {
  test('* is any run of characters, and a final $ the end of the path', () => {
    expect(patternMatches('/fish', '/fish.html')).toBe(true)
    expect(patternMatches('/fish', '/Fish.asp')).toBe(false)
    expect(patternMatches('/fish*', '/fish')).toBe(true)
    expect(patternMatches('/fish/', '/fish')).toBe(false)
    expect(patternMatches('/*.php', '/folder/filename.php?parameters')).toBe(true)
    expect(patternMatches('/*.php$', '/filename.php')).toBe(true)
    expect(patternMatches('/*.php$', '/filename.php?parameters')).toBe(false)
    expect(patternMatches('/*.php$', '/filename.php5')).toBe(false)
    expect(patternMatches('/fish*.php', '/fishheads/catfish.php?parameters')).toBe(true)
    expect(patternMatches('/fish*.php', '/Fish.PHP')).toBe(false)
    expect(patternMatches('/a*b*c$', '/axxbyyc')).toBe(true)
    expect(patternMatches('/a*b*c$', '/axxbyycd')).toBe(false)
    // The tail may not overlap what the pieces before it took.
    expect(patternMatches('/ab*b$', '/ab')).toBe(false)
    expect(patternMatches('/ab*b$', '/abb')).toBe(true)
    expect(patternMatches('*', '/anything')).toBe(true)
    expect(patternMatches('/$', '/')).toBe(true)
    // A $ anywhere but the end is a character like any other.
    expect(patternMatches('/a$b', '/a$b/c')).toBe(true)
  })

  test('many wildcards against a long path take no time: nothing backtracks', () => {
    const pattern = `/${'a*'.repeat(200)}b$`
    const path = `/${'a'.repeat(50_000)}`
    const started = performance.now()
    expect(patternMatches(pattern, path)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('encodings', () => {
  test('paths compare percent-encoded alike on both sides (RFC 9309, 2.2.2)', () => {
    expect(normalizePath('/foo/bar?baz=quz')).toBe('/foo/bar?baz=quz')
    expect(normalizePath('/foo/jalapeño')).toBe('/foo/jalape%C3%B1o')
    expect(normalizePath('/foo/jalape%c3%b1o')).toBe('/foo/jalape%C3%B1o')
    expect(normalizePath('/foo/%62%61%72')).toBe('/foo/bar')
    // Reserved characters stay encoded, and a lone % is a percent sign.
    expect(normalizePath('/a%2Fb')).toBe('/a%2Fb')
    expect(normalizePath('/100%')).toBe('/100%25')
    expect(normalizePath('/a b')).toBe('/a%20b')
  })

  test('characters a URL arrives encoded match a rule that writes them raw', () => {
    expect(allows('User-agent: *\nDisallow: /{x}\n', '/{x}')).toBe(false)
    expect(allows("User-agent: *\nDisallow: /search?q='\n", "/search?q='a")).toBe(false)
    expect(allows('User-agent: *\nDisallow: /a"b<c>\n', '/a"b<c>')).toBe(false)
  })

  test('a rule written in any script matches the address a browser would send', () => {
    const text = 'User-agent: *\nDisallow: /草稿/\nDisallow: /caf%C3%A9\n'
    expect(allows(text, '/草稿/一')).toBe(false)
    expect(allows(text, `/${encodeURIComponent('草稿')}/1`)).toBe(false)
    expect(allows(text, '/café')).toBe(false)
    expect(allows(text, '/cafe')).toBe(true)
    expect(allows('User-agent: *\nDisallow: /%62ar', '/bar')).toBe(false)
  })

  test('a byte-order mark, CRLF or CR line ends, comments, spacing and old typos', () => {
    const text =
      '﻿User-agent: Tela # us\r\nDisallow: /a # not this\r\n  disallow :  /b  \rDISALLOW:/c\nDisalow: /d\nuser agent: Tela\n'
    for (const path of ['/a', '/b', '/c', '/d']) expect(allows(text, path)).toBe(false)
    expect(allows(text, '/e')).toBe(true)
    expect(allows('User-agent: *\nDisallow: /a#comment', '/a')).toBe(false)
    expect(allows('User-agent: *\nDisallow: #nothing', '/a')).toBe(true)
  })
})

describe('a huge file', () => {
  test('is read only to its first 500 KiB, and quickly', () => {
    const line = 'Disallow: /ignored-path-that-is-long-enough/\n'
    const filler = line.repeat(Math.ceil((2 * 1024 * 1024) / line.length))
    const text = `User-agent: *\n${filler}Disallow: /past-the-cap\n`
    expect(text.length).toBeGreaterThan(ROBOTS_MAX_BYTES * 4)
    const started = performance.now()
    expect(allows(text, '/past-the-cap')).toBe(true)
    expect(allows(text, '/ignored-path-that-is-long-enough/1')).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('what Tela keeps', () => {
  test('is the group that applies, written back as a file that says the same', () => {
    const text =
      'User-agent: *\nDisallow: /all\n\nUser-agent: Tela/1\nDisallow: /x*.pdf$\nAllow: /x/open\n'
    const kept = serializeRules(rulesFor(parseRobots(text)))
    expect(kept).toBe('User-agent: Tela\nDisallow: /x*.pdf$\nAllow: /x/open\n')
    for (const path of ['/all', '/x/a.pdf', '/x/open/a.pdf', '/x/a.pdfs'])
      expect(allows(kept, path)).toBe(allows(text, path))
    const everyone = serializeRules(rulesFor(parseRobots('User-agent: *\nDisallow: /')))
    expect(everyone).toBe('User-agent: *\nDisallow: /\n')
    expect(allows(everyone, '/a')).toBe(false)
    // A group with no rules is kept as one, and still overrides everyone's.
    expect(
      serializeRules(rulesFor(parseRobots('User-agent: Tela\nUser-agent: *\nDisallow: /'))),
    ).toBe('User-agent: Tela\nDisallow: /\n')
    expect(
      serializeRules(rulesFor(parseRobots('User-agent: *\nDisallow: /\nUser-agent: Tela'))),
    ).toBe('User-agent: Tela\n')
    expect(serializeRules(null)).toBe('')
    expect(allowedBy([], at('/anything'))).toBe(true)
  })

  test('is found by the product token Tela fetches with', () => {
    const config = readFileSync(join(import.meta.dir, '../../../apps/jobs/wrangler.jsonc'), 'utf8')
    const agent = config.match(/"WORKER_USER_AGENT":\s*"([^"]+)"/)?.[1] ?? ''
    expect(agent).toStartWith('Tela/')
    expect(/^[A-Za-z_-]+/.exec(agent)?.[0]?.toLowerCase()).toBe(ROBOTS_TOKEN)
  })
})
