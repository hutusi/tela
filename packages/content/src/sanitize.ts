import render from 'dom-serializer'
import { type ChildNode, Element, isTag, type ParentNode, Text } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import sanitizeHtml, { type IOptions } from 'sanitize-html'
import { absoluteUrl } from './url'

/** Block-level elements that survive sanitization. Wrappers are unwrapped later. */
export const BLOCK_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'hr',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
] as const

export const INLINE_TAGS = [
  'a',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'sub',
  'sup',
  'span',
  'abbr',
  'cite',
  'q',
  'small',
  'kbd',
  'samp',
  'var',
  'code',
  'br',
  'img',
  'time',
  'dfn',
  'bdi',
  'bdo',
  'wbr',
] as const

/** Elements removed together with their content. */
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'template',
  'svg',
  'iframe',
  'video',
  'audio',
  'object',
  'embed',
  'form',
  'button',
  'input',
  'select',
  'canvas',
  'math',
  'head',
  'title',
]

const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc']

function pickImageSource(attribs: Record<string, string>, baseUrl?: string): string | null {
  const src = attribs.src
  const srcIsPlaceholder = !src || src.startsWith('data:') || src.startsWith('blob:')
  const candidates = srcIsPlaceholder
    ? [...LAZY_SRC_ATTRS.map((a) => attribs[a]), src]
    : [src, ...LAZY_SRC_ATTRS.map((a) => attribs[a])]
  for (const candidate of candidates) {
    if (!candidate) continue
    const abs = absoluteUrl(candidate, baseUrl)
    if (abs) return abs
  }
  return null
}

const EMBEDS = new Set(['iframe', 'video', 'audio'])
/** Players: what plays (▶) rather than opens (↗). */
const PLAYER_HOSTS =
  /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|bilibili\.com|dailymotion\.com|youku\.com|ted\.com|bandcamp\.com|soundcloud\.com|spotify\.com)$/
/**
 * An iframe that is a player by its address (`/embed`, `/player`, `/video`…): komoot's routes,
 * a broadcaster's player. Any other iframe is a widget (slashdot's "discuss" box on every item, a
 * like button) and is dropped, as it was.
 */
const PLAYER_PATH = /\/(?:embed|player|video|videos|play|watch)(?:\/|$)/i
/** Link cards whose `url` parameter is the post they show (Hatena's blog cards, Embedly, iframely). */
const CARD_HOSTS = /(?:^|\.)(?:hatenablog-parts\.com|embedly\.com|iframe\.ly)$/

/** Where an embed's source can be watched or opened as a page, not as a player. */
function pageOfEmbed(src: string): string {
  const u = new URL(src)
  const host = u.hostname.replace(/^www\./, '')
  const youtube =
    /^(?:youtube\.com|youtube-nocookie\.com)$/.test(host) && u.pathname.match(/^\/embed\/([\w-]+)/)
  if (youtube) return `https://www.youtube.com/watch?v=${youtube[1]}`
  const vimeo = host === 'player.vimeo.com' && u.pathname.match(/^\/video\/(\d+)/)
  if (vimeo) return `https://vimeo.com/${vimeo[1]}`
  const card = CARD_HOSTS.test(host) ? absoluteUrl(u.searchParams.get('url') ?? '') : null
  if (card) return card
  return u.toString()
}

/** The address a link shows for an embed: host and path, with a watch page's video id. */
function labelOf(page: string): string {
  const u = new URL(page)
  const host = u.hostname.replace(/^www\./, '')
  const v = host === 'youtube.com' && u.pathname === '/watch' ? `?v=${u.searchParams.get('v')}` : ''
  return `${host}${u.pathname === '/' ? '' : u.pathname}${v}`
}

/** Video and audio always; an iframe only when it is a player or a card, never a widget. */
function linkable(el: Element, src: string): boolean {
  if (el.name !== 'iframe') return true
  const u = new URL(src)
  return (
    PLAYER_HOSTS.test(u.hostname) || CARD_HOSTS.test(u.hostname) || PLAYER_PATH.test(u.pathname)
  )
}

function sourceOf(el: Element, baseUrl?: string): string | null {
  const own = el.attribs.src || el.attribs['data-src']
  const candidates = own ? [own] : []
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isTag(n)) continue
      if (n.name === 'source' && n.attribs.src) candidates.push(n.attribs.src)
      walk(n.children)
    }
  }
  if (!own) walk(el.children)
  for (const c of candidates) {
    const abs = absoluteUrl(c, baseUrl)
    if (abs) return abs
  }
  return null
}

/**
 * Whether a citation right after the embed already links to `page`: Hatena writes
 * `<cite><a href="…">github.com</a></cite>` after each of its blog cards, so a link for the card
 * would say the same thing twice.
 */
function citedAfter(el: Element, page: string, baseUrl?: string): boolean {
  let next = el.next
  while (next && !isTag(next) && !/\S/.test((next as Text).data ?? '')) next = next.next
  if (!next || !isTag(next) || next.name !== 'cite') return false
  const links: string[] = []
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isTag(n)) continue
      if (n.name === 'a' && n.attribs.href) links.push(absoluteUrl(n.attribs.href, baseUrl) ?? '')
      walk(n.children)
    }
  }
  walk(next.children)
  return links.includes(page)
}

function linkEmbeds(parent: ParentNode, baseUrl?: string) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child) && EMBEDS.has(child.name)) {
      const src = sourceOf(child, baseUrl)
      const page = src && linkable(child, src) ? pageOfEmbed(src) : null
      if (page && !citedAfter(child, page, baseUrl)) {
        const video = child.name !== 'iframe' || PLAYER_HOSTS.test(new URL(page).hostname)
        const a = new Element('a', { href: page }, [
          new Text(`${video ? '▶' : '↗'} ${labelOf(page)}`),
        ])
        // A block of its own, as the player was: inside a paragraph it would change the
        // paragraph's text, and with it the hash its translation is cached under.
        next.push(new Element('div', {}, [a]))
      }
      continue
    }
    if (isTag(child)) linkEmbeds(child, baseUrl)
    next.push(child)
  }
  parent.children = next
  for (const [i, n] of next.entries()) {
    n.parent = parent as ParentNode
    n.prev = next[i - 1] ?? null
    n.next = next[i + 1] ?? null
  }
}

/**
 * A video, a player or a map (iframe, video, audio) becomes a link to where it can be opened:
 * nothing embedded runs on Tela, and it was removed without a trace, so a post built around a
 * video read with a hole in it (ADR 0054). A YouTube or Vimeo player links to its watch page.
 * Parsed only when the HTML has an embed at all.
 */
export function embedsAsLinks(html: string, baseUrl?: string): string {
  if (!/<(?:iframe|video|audio)\b/i.test(html)) return html
  const doc = parseDocument(html)
  linkEmbeds(doc, baseUrl)
  return render(doc, { encodeEntities: 'utf8' })
}

/**
 * Allowlist sanitization of article HTML. Links and images are made absolute against
 * `baseUrl` (the article URL, falling back to the feed URL); anything that cannot be
 * resolved to http(s) loses its href or is dropped. Lazy-loading image attributes are
 * folded into src. Tracking pixels are removed.
 */
export function sanitizeArticleHtml(html: string, baseUrl?: string): string {
  const options: IOptions = {
    allowedTags: [...BLOCK_TAGS, ...INLINE_TAGS],
    allowedAttributes: {
      a: ['href', 'title', 'hreflang'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      ol: ['start', 'reversed', 'type'],
      li: ['value'],
      code: ['class'],
      pre: ['class'],
      abbr: ['title'],
      dfn: ['title'],
      q: ['cite'],
      blockquote: ['cite'],
      details: ['open'],
      time: ['datetime'],
      '*': ['dir', 'lang'],
    },
    allowedClasses: {
      code: ['language-*', 'lang-*'],
      pre: ['language-*', 'lang-*'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: true,
    nonTextTags: NON_TEXT_TAGS,
    transformTags: {
      a: (tagName, attribs) => {
        const raw = attribs.href?.trim()
        if (!raw) return { tagName: 'span', attribs: {} }
        if (raw.toLowerCase().startsWith('mailto:'))
          return { tagName, attribs: { ...attribs, href: raw } }
        const href = absoluteUrl(raw, baseUrl)
        if (!href) return { tagName: 'span', attribs: {} }
        return { tagName, attribs: { ...attribs, href } }
      },
      img: (tagName, attribs) => {
        const src = pickImageSource(attribs, baseUrl)
        const out: Record<string, string> = {}
        if (src) out.src = src
        if (attribs.alt) out.alt = attribs.alt
        if (attribs.title) out.title = attribs.title
        if (attribs.width) out.width = attribs.width
        if (attribs.height) out.height = attribs.height
        return { tagName, attribs: out }
      },
      font: 'span',
      center: 'div',
      strike: 's',
      tt: 'code',
      picture: 'span',
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const a = frame.attribs
        if (!a.src) return true
        if (a.width === '1' && a.height === '1') return true
      }
      return false
    },
    parser: { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  }
  return sanitizeHtml(embedsAsLinks(html, baseUrl), options)
}
