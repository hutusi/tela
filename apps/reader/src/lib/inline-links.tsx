/**
 * The one piece of markup the info pages' copy carries: `[text](href)`. The copy is ours, but the
 * renderer still allows only https and same-site links, so a slip in a translation can never ship
 * a `javascript:` URL. Anything else stays text.
 */
import { Link } from 'react-router'

export type InlinePart = { text: string } | { text: string; href: string }

const LINK = /\[([^\]]+)\]\(([^()\s]+)\)/g

/** A link the pages may carry: https, a path on this site, or an anchor on this page. */
export function safeHref(href: string): string | null {
  if (/^#[A-Za-z][\w-]*$/.test(href)) return href
  // One leading slash, never two or a backslash: `//host` and `/\host` leave the site.
  if (/^\/(?![/\\])[\w\-./~%?=&#]*$/.test(href)) return href
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? href : null
  } catch {
    return null
  }
}

/** The text split into plain runs and links; a link whose address is refused is its text alone. */
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let last = 0
  for (const match of text.matchAll(LINK)) {
    const [whole, label = '', href = ''] = match
    const at = match.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at) })
    const safe = safeHref(href)
    parts.push(safe ? { text: label, href: safe } : { text: label })
    last = at + whole.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  // Neighbouring plain runs (a refused link beside its text) read as one.
  return parts.reduce<InlinePart[]>((out, part) => {
    const prev = out[out.length - 1]
    if (prev && !('href' in prev) && !('href' in part)) prev.text += part.text
    else out.push({ ...part })
    return out
  }, [])
}

/** The text with its links drawn out, for a page's meta description. */
export function plainText(text: string): string {
  return parseInline(text)
    .map((p) => p.text)
    .join('')
}

export function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) => {
        if (!('href' in part)) return part.text
        const key = `${i}:${part.href}`
        // A path on this site stays in the app; an anchor and another site are ordinary links.
        return part.href.startsWith('/') ? (
          <Link key={key} to={part.href}>
            {part.text}
          </Link>
        ) : (
          <a
            key={key}
            href={part.href}
            {...(part.href.startsWith('#') ? {} : { rel: 'noopener noreferrer' })}
          >
            {part.text}
          </a>
        )
      })}
    </>
  )
}
