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
  return sanitizeHtml(html, options)
}
