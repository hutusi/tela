/**
 * robots.txt, as RFC 9309 reads it, for the pages Tela fetches (ADR 0061): a post's page for its
 * full text, and a blog's home page for its favicon. Feeds never ask it, as in any feed reader:
 * a feed is published to be read by programs, and a reader who subscribed asked for it.
 *
 * - Groups are one or more `User-agent` lines and the rules under them. Tela's group is the one
 *   naming its product token (`Tela`, from its user agent `Tela/0.1 (+https://telaread.com; feed
 *   reader)`), else the `*` group; several groups naming the same agent are one group. No group,
 *   or a group without rules, allows everything.
 * - A rule is `Allow` or `Disallow` and a path pattern: `*` is any run of characters, a final `$`
 *   ends the path. The longest matching pattern decides, and `Allow` wins a tie. An empty
 *   `Disallow:` matches nothing.
 * - Paths compare percent-encoded the same way on both sides: non-ASCII as UTF-8, `%xx` of an
 *   unreserved character decoded, hex digits upper-case.
 * - Only the first `ROBOTS_MAX_BYTES` are read, as the RFC asks at least: the fetch stops there,
 *   and the parser reads no more characters than that either.
 *
 * Pure and runtime-agnostic: no fetch here (`pipeline/robots.ts` does that), no regular expression
 * built from a file (a pattern of many `*` cannot backtrack into a long path).
 */

/** The product token Tela's group is found by, matched case-insensitively. */
export const ROBOTS_TOKEN = 'tela'

/** How much of a robots.txt is read: the 500 KiB RFC 9309 asks every crawler to parse. */
export const ROBOTS_MAX_BYTES = 500 * 1024

export type RobotsRule = { allow: boolean; path: string }
export type RobotsGroup = { agents: string[]; rules: RobotsRule[] }

/** The group that applies to one agent: which agent line chose it, and its rules. */
export type RobotsMatch = { agent: string; rules: RobotsRule[] }

/** The keys a line may start with, as crawlers have long accepted them, typos included. */
const KEYS: Record<string, 'agent' | 'allow' | 'disallow'> = {
  'user-agent': 'agent',
  useragent: 'agent',
  'user agent': 'agent',
  allow: 'allow',
  disallow: 'disallow',
  dissallow: 'disallow',
  dissalow: 'disallow',
  disalow: 'disallow',
  diasllow: 'disallow',
  disallaw: 'disallow',
}

/**
 * An agent line's product token, lower-case: the run of letters, `_` and `-` it starts with
 * (`Tela/0.1` names `tela`), or `*`. Null for a line that names no agent.
 */
function tokenOf(value: string): string | null {
  if (value.startsWith('*')) return '*'
  const token = /^[A-Za-z_-]+/.exec(value)?.[0]
  return token ? token.toLowerCase() : null
}

/** Every group in a robots.txt, in order; lines outside a group, and other records, ignored. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  // A group's agent lines end at its first rule: an agent line after a rule starts another.
  let inRules = false
  const body = text.slice(0, ROBOTS_MAX_BYTES).replace(/^﻿/, '')
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf('#')
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = KEYS[line.slice(0, colon).trim().toLowerCase().replace(/\s+/g, ' ')]
    if (!key) continue
    const value = line.slice(colon + 1).trim()
    if (key === 'agent') {
      const token = tokenOf(value)
      if (!token) continue
      if (!current || inRules) {
        current = { agents: [], rules: [] }
        groups.push(current)
        inRules = false
      }
      current.agents.push(token)
      continue
    }
    // A rule before any agent line belongs to no group.
    if (!current) continue
    inRules = true
    // `Disallow:` with nothing after it disallows nothing; so does an empty `Allow:`.
    if (value === '') continue
    current.rules.push({ allow: key === 'allow', path: value })
  }
  return groups
}

/**
 * The rules for `token`: every group naming it, as one; else every `*` group, as one; else null,
 * and everything is allowed.
 */
export function rulesFor(groups: RobotsGroup[], token: string = ROBOTS_TOKEN): RobotsMatch | null {
  const wanted = token.toLowerCase()
  for (const agent of [wanted, '*']) {
    const named = groups.filter((g) => g.agents.includes(agent))
    if (named.length > 0) return { agent, rules: named.flatMap((g) => g.rules) }
  }
  return null
}

const UNRESERVED = /[A-Za-z0-9\-._~]/
const HEX = '0123456789ABCDEF'

/**
 * A path as RFC 9309 compares it: every byte outside printable ASCII percent-encoded as UTF-8,
 * `%xx` decoded when it is an unreserved character and upper-cased otherwise. A `%` not followed
 * by two hex digits is a literal percent sign, and is encoded as one.
 */
export function normalizePath(path: string): string {
  let out = ''
  const bytes = new TextEncoder().encode(path)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b === 0x25) {
      const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        const char = String.fromCharCode(Number.parseInt(hex, 16))
        out += UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`
        i += 2
      } else {
        out += '%25'
      }
      continue
    }
    if (b <= 0x20 || b >= 0x7f) {
      out += `%${HEX[b >> 4]}${HEX[b & 15]}`
      continue
    }
    out += String.fromCharCode(b)
  }
  return out
}

/**
 * Whether `pattern` matches the start of `path` (both normalized): `*` matches any run of
 * characters, a final `$` the end. Each `*`-separated piece is found leftmost, which leaves the
 * most room for the rest, so it never backtracks.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*')
  const head = pieces[0] as string
  if (!path.startsWith(head)) return false
  if (pieces.length === 1) return !anchored || path.length === head.length
  let at = head.length
  for (let i = 1; i < pieces.length - 1; i++) {
    const piece = pieces[i] as string
    const found = path.indexOf(piece, at)
    if (found < 0) return false
    at = found + piece.length
  }
  const tail = pieces.at(-1) as string
  if (anchored) return path.length - tail.length >= at && path.endsWith(tail)
  return path.indexOf(tail, at) >= 0
}

/** The path and query RFC 9309 matches a URL by, normalized. */
export function robotsPath(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url
  return normalizePath(`${u.pathname || '/'}${u.search}`)
}

/**
 * Whether `rules` let Tela fetch `url`: the longest matching pattern decides, `Allow` on a tie,
 * and a path no rule matches is allowed. `/robots.txt` itself is always allowed.
 */
export function allowedBy(rules: readonly RobotsRule[], url: string | URL): boolean {
  const path = robotsPath(url)
  if (path === '/robots.txt') return true
  let best = -1
  let allow = true
  for (const rule of rules) {
    // `*` and `$` are printable ASCII, so normalizing keeps them as the wildcards they are.
    const pattern = normalizePath(rule.path)
    if (pattern.length < best || !patternMatches(pattern, path)) continue
    if (pattern.length > best) {
      best = pattern.length
      allow = rule.allow
    } else if (rule.allow) {
      allow = true
    }
  }
  return allow
}

/** Whether a robots.txt lets Tela (or `token`) fetch `url`. */
export function robotsAllows(text: string, url: string | URL, token = ROBOTS_TOKEN): boolean {
  const match = rulesFor(parseRobots(text), token)
  return match ? allowedBy(match.rules, url) : true
}

/**
 * The rules that apply to Tela, written back as a robots.txt of one group, which `parseRobots`
 * reads as the same rules: what `robots_rules.body` keeps, so a stored row says exactly what Tela
 * obeys and a page check reads no more than that. Empty when no group applies.
 */
export function serializeRules(match: RobotsMatch | null): string {
  if (!match) return ''
  const agent = match.agent === '*' ? '*' : 'Tela'
  return [
    `User-agent: ${agent}`,
    ...match.rules.map((r) => `${r.allow ? 'Allow' : 'Disallow'}: ${r.path}`),
    '',
  ].join('\n')
}
