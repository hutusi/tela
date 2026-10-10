/**
 * What a blog's page says about who it belongs to (ADRs 0011, 0045): the token in a meta tag, and
 * every link to a Tela profile or a GitHub profile, with whether it says "this is me" (`rel="me"`)
 * or is marked as someone else's (`nofollow`, `ugc`, `sponsored`, which comment sections put on a
 * commenter's link). Deciding what counts is the claim check's job, in `sites.ts`.
 */
import { FORMER_PUBLIC_HOSTS } from '@tela/shared'
import { findAll, getAttributeValue } from 'domutils'
import { parseDocument } from 'htmlparser2'

export const VERIFICATION_META = 'tela-site-verification'

export type ProfileLink = {
  /** The handle or login, lower-cased. */
  name: string
  me: boolean
  /** The `rel` words that mark it as someone else's, or null. */
  marked: string | null
}

export type PageProofs = {
  meta: boolean
  profiles: ProfileLink[]
  github: ProfileLink[]
}

const MARKS = new Set(['nofollow', 'ugc', 'sponsored'])
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const PROFILE_PATH = /^\/@([a-z0-9_]{3,30})\/?$/i
const GITHUB_PATH = /^\/([a-z0-9-]{1,39})\/?$/i

/** The hosts a link to a member's Tela profile may name: this one, with or without `www.`, and the old address. */
export function profileHosts(publicUrl: string): ReadonlySet<string> {
  const bare = new URL(publicUrl).host.toLowerCase().replace(/^www\./, '')
  return new Set([bare, `www.${bare}`, ...FORMER_PUBLIC_HOSTS])
}

function target(href: string, pageUrl: string): URL | null {
  try {
    const url = new URL(href.trim(), pageUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function decodedPath(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

/**
 * Read a page. A link is read as a browser would follow it: `http` or `https`, any letter case, a
 * trailing slash, a query or a fragment, `%40` for `@`, and relative to the page, so a relative
 * `/@name` is the blog's own path and never a Tela profile.
 */
export function readProofs(
  html: string,
  pageUrl: string,
  token: string,
  telaHosts: ReadonlySet<string>,
): PageProofs {
  const doc = parseDocument(html)
  const meta = findAll((el) => el.name === 'meta', doc.children).some(
    (el) =>
      (getAttributeValue(el, 'name') ?? '').toLowerCase() === VERIFICATION_META &&
      (getAttributeValue(el, 'content') ?? '').trim() === token,
  )
  const profiles: ProfileLink[] = []
  const github: ProfileLink[] = []
  for (const el of findAll((el) => el.name === 'a' || el.name === 'link', doc.children)) {
    const url = target(getAttributeValue(el, 'href') ?? '', pageUrl)
    if (!url) continue
    const host = url.host.toLowerCase()
    const into = telaHosts.has(host) ? profiles : GITHUB_HOSTS.has(host) ? github : null
    if (!into) continue
    const name = decodedPath(url)?.match(into === profiles ? PROFILE_PATH : GITHUB_PATH)?.[1]
    if (!name) continue
    const rel = (getAttributeValue(el, 'rel') ?? '').toLowerCase().split(/\s+/)
    const marks = rel.filter((word) => MARKS.has(word))
    into.push({
      name: name.toLowerCase(),
      me: rel.includes('me'),
      marked: marks.length > 0 ? marks.join(' ') : null,
    })
  }
  return { meta, profiles, github }
}

/**
 * Does a website, as typed into a GitHub profile, name this blog? By host, without `www.`: a path
 * on it is still the blog, and a scheme is often left out (`hutusi.com`).
 */
export function namesSite(website: string, homeUrl: string): boolean {
  if (!website) return false
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`)
    return bare(url.hostname) === bare(new URL(homeUrl).hostname)
  } catch {
    return false
  }
}
