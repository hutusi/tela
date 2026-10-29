/**
 * Which blog an address belongs to (ADR 0069). A blog is an origin, except on a host many writers
 * share, where each writer's blog is the first segment of the path, and in a section of a site
 * that is a blog of its own, named here. The rules are code, not data: such blogs are rare and an
 * editor's call, and every caller resolves a key at once, without reading the database.
 */
export type BlogRules = {
  /** Hosts whose first path segment is a writer's blog, a feed and its `<link>` both under it. */
  readonly sharedHosts: readonly string[]
  /** Sections of a site that are blogs of their own, each as its key: scheme, host and path. */
  readonly pathBlogs: readonly string[]
}

export const BLOG_RULES: BlogRules = {
  sharedHosts: ['world.hey.com', 'buttondown.com', 'buttondown.email', 'devblogs.microsoft.com'],
  pathBlogs: [
    'https://www.anthropic.com/research',
    'https://www.anthropic.com/engineering',
    'https://www.microsoft.com/en-us/research',
  ],
}

function httpUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')

/** A path's segments, lowercase, the empty ones (a trailing slash) dropped. */
const segments = (path: string) => path.toLowerCase().split('/').filter(Boolean)

/**
 * The key of the blog at `input`, as `sites.home_url` holds it: the origin (scheme as given,
 * lowercase host, a port that is not the default), or for a blog by path the origin and that
 * path. A shared host's bare root stays the host's own key. Null for what is not http(s).
 */
export function siteKeyOf(input: string, rules: BlogRules = BLOG_RULES): string | null {
  const url = httpUrl(input)
  if (!url) return null
  const origin = url.origin.toLowerCase()
  const host = bare(url.hostname)
  const parts = segments(url.pathname)
  if (rules.sharedHosts.some((shared) => bare(shared) === host)) {
    return parts[0] ? `${origin}/${parts[0]}` : origin
  }
  // The deepest section the address is in, by whole segments: /researchers is not /research.
  let found: { key: string; depth: number } | null = null
  for (const key of rules.pathBlogs) {
    const at = httpUrl(key)
    if (!at || bare(at.hostname) !== host || at.port !== url.port) continue
    const want = segments(at.pathname)
    if (want.length > parts.length || want.some((segment, i) => segment !== parts[i])) continue
    if (!found || want.length > found.depth) found = { key, depth: want.length }
  }
  return found?.key ?? origin
}

/** Whether `key` is a blog on a host many writers share, whose pages are the host's. */
export function isSharedHost(key: string, rules: BlogRules = BLOG_RULES): boolean {
  const url = httpUrl(key)
  return url !== null && rules.sharedHosts.some((shared) => bare(shared) === bare(url.hostname))
}

/** Whether two keys name one blog, whatever their scheme or `www.`. */
export function sameBlog(a: string, b: string): boolean {
  const x = httpUrl(a)
  const y = httpUrl(b)
  if (!x || !y) return false
  const name = (url: URL) => `${bare(url.hostname)}:${url.port}/${segments(url.pathname).join('/')}`
  return name(x) === name(y)
}
