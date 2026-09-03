/** Query parameters that only carry tracking state and never change the page. */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|vero_id|wt_mc|spm|ref_src|ncid|share_token)$/i

function parse(input: string, base?: string): URL | null {
  try {
    return new URL(input.trim(), base)
  } catch {
    return null
  }
}

function isHttp(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:'
}

/** Resolve `href` against `base` and return an absolute http(s) URL, or null. */
export function absoluteUrl(href: string, base?: string): string | null {
  const u = parse(href, base)
  if (!u || !isHttp(u)) return null
  return u.toString()
}

/**
 * Canonical site identity: scheme + lowercase host (+ non-default port), no path.
 * Scheme is kept as given so an http-only site stays reachable for claim checks.
 */
export function normalizeOrigin(input: string, base?: string): string | null {
  const u = parse(input, base)
  if (!u || !isHttp(u)) return null
  return u.origin.toLowerCase()
}

/**
 * Dedup form of an article link: https, lowercase host, no fragment, tracking
 * parameters removed, remaining parameters sorted, trailing slash trimmed.
 */
export function normalizeForDedup(input: string, base?: string): string | null {
  const u = parse(input, base)
  if (!u || !isHttp(u)) return null
  u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase()
  u.hash = ''
  u.username = ''
  u.password = ''
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  u.search = ''
  for (const [k, v] of kept) u.searchParams.append(k, v)
  let path = u.pathname.replace(/\/+$/, '')
  if (path === '') path = '/'
  u.pathname = path
  return u.toString()
}

/** Hostname helper for display: strips www. */
export function displayHost(input: string): string {
  const u = parse(input)
  if (!u) return input
  return u.hostname.replace(/^www\./, '')
}
