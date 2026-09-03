/**
 * Tagged text: the form of a block that the translation model sees and that the
 * translation cache is keyed by.
 *
 * Inline markup becomes XLIFF-style placeholders so the model never handles HTML:
 *   paired   <g1>…</g1>   for a, em, strong, span, … (children are translated)
 *   opaque   <x1/>        for br, img, code, kbd, … (content is copied verbatim)
 * Everything outside placeholders is HTML-escaped text. Attributes and opaque
 * content live in a side table derived from the source block, never in the text,
 * so two sentences that differ only by a link target share one cache entry.
 */
import { decodeHTML, escapeUTF8 } from 'entities'

export const PAIRED_INLINE = new Set([
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
  'dfn',
  'bdi',
  'bdo',
  'time',
])

export const OPAQUE_INLINE = new Set(['br', 'img', 'code', 'kbd', 'samp', 'var', 'wbr'])

export type Placeholder = {
  tag: string
  attrs: Record<string, string>
  /** Serialized inner HTML for opaque placeholders (e.g. the code text). */
  html?: string
}

export type Placeholders = Record<string, Placeholder>

/** Minimal node shape so this module has no dependency on a DOM library. */
export type InlineNode =
  | { type: 'text'; data: string }
  | { type: 'tag'; name: string; attribs: Record<string, string>; children: InlineNode[] }

function escapeText(text: string): string {
  return escapeUTF8(text)
}

function attrsToHtml(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeUTF8(v).replace(/"/g, '&quot;')}"`)
    .join('')
}

function serializeNode(node: InlineNode): string {
  if (node.type === 'text') return escapeText(node.data)
  const inner = node.children.map(serializeNode).join('')
  if (node.name === 'br' || node.name === 'img' || node.name === 'wbr') {
    return `<${node.name}${attrsToHtml(node.attribs)}>`
  }
  return `<${node.name}${attrsToHtml(node.attribs)}>${inner}</${node.name}>`
}

/** Convert a block's inline children into tagged text plus its placeholder table. */
export function toTaggedText(children: InlineNode[]): { text: string; placeholders: Placeholders } {
  const placeholders: Placeholders = {}
  let g = 0
  let x = 0
  const walk = (nodes: InlineNode[]): string => {
    let out = ''
    for (const node of nodes) {
      if (node.type === 'text') {
        out += escapeText(node.data)
        continue
      }
      if (OPAQUE_INLINE.has(node.name)) {
        x += 1
        const key = `x${x}`
        const html =
          node.children.length > 0 ? node.children.map(serializeNode).join('') : undefined
        placeholders[key] =
          html === undefined
            ? { tag: node.name, attrs: node.attribs }
            : { tag: node.name, attrs: node.attribs, html }
        out += `<${key}/>`
        continue
      }
      if (PAIRED_INLINE.has(node.name)) {
        g += 1
        const key = `g${g}`
        placeholders[key] = { tag: node.name, attrs: node.attribs }
        out += `<${key}>${walk(node.children)}</${key}>`
        continue
      }
      // Unknown inline element: keep its text, drop the tag.
      out += walk(node.children)
    }
    return out
  }
  return { text: walk(children), placeholders }
}

const TOKEN = /<(g\d+)>|<\/(g\d+)>|<(x\d+)\/>/g

export type Token =
  | { kind: 'text'; value: string }
  | { kind: 'open'; key: string }
  | { kind: 'close'; key: string }
  | { kind: 'opaque'; key: string }

/** Split tagged text into text segments and placeholder tokens. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0
    if (index > last) tokens.push({ kind: 'text', value: text.slice(last, index) })
    if (m[1]) tokens.push({ kind: 'open', key: m[1] })
    else if (m[2]) tokens.push({ kind: 'close', key: m[2] })
    else if (m[3]) tokens.push({ kind: 'opaque', key: m[3] })
    last = index + m[0].length
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) })
  return tokens
}

/**
 * Rebuild inner HTML from tagged text and the placeholder table. Text segments are
 * decoded then re-escaped, so anything that is not a known placeholder is rendered
 * literally: the model cannot inject markup. Unbalanced or unknown placeholders are
 * dropped rather than rendered.
 */
export function fromTaggedText(text: string, placeholders: Placeholders): string {
  let out = ''
  const stack: string[] = []
  for (const token of tokenize(text)) {
    if (token.kind === 'text') {
      out += escapeUTF8(decodeHTML(token.value))
      continue
    }
    const ph = placeholders[token.key]
    if (!ph) continue
    if (token.kind === 'opaque') {
      if (ph.tag === 'br' || ph.tag === 'img' || ph.tag === 'wbr') {
        out += `<${ph.tag}${attrsToHtml(ph.attrs)}>`
      } else {
        out += `<${ph.tag}${attrsToHtml(ph.attrs)}>${ph.html ?? ''}</${ph.tag}>`
      }
      continue
    }
    if (token.kind === 'open') {
      stack.push(token.key)
      out += `<${ph.tag}${attrsToHtml(ph.attrs)}>`
      continue
    }
    // close
    if (stack[stack.length - 1] === token.key) {
      stack.pop()
      out += `</${ph.tag}>`
    }
  }
  while (stack.length > 0) {
    const key = stack.pop() as string
    const ph = placeholders[key]
    if (ph) out += `</${ph.tag}>`
  }
  return out
}

/** Plain text of tagged text: placeholders removed, entities decoded. */
export function plainText(text: string): string {
  return tokenize(text)
    .map((t) => (t.kind === 'text' ? decodeHTML(t.value) : t.kind === 'opaque' ? ' ' : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export type PlaceholderCheck = { ok: true } | { ok: false; reason: string }

/**
 * A translation is acceptable only if it carries exactly the placeholders of the
 * source: every gN opened and closed once, every xN once, all properly nested.
 */
export function checkPlaceholders(source: string, translated: string): PlaceholderCheck {
  const signature = (tokens: Token[]) =>
    tokens
      .filter((t) => t.kind !== 'text')
      .map((t) => `${t.kind}:${(t as { key: string }).key}`)
      .sort()
      .join(',')
  const src = tokenize(source)
  const dst = tokenize(translated)
  if (signature(src) !== signature(dst)) {
    return { ok: false, reason: 'placeholder set differs from source' }
  }
  const stack: string[] = []
  for (const t of dst) {
    if (t.kind === 'open') stack.push(t.key)
    else if (t.kind === 'close') {
      if (stack.pop() !== t.key)
        return { ok: false, reason: `placeholder ${t.key} is not nested properly` }
    }
  }
  if (stack.length > 0) return { ok: false, reason: `placeholder ${stack[0]} is never closed` }
  return { ok: true }
}
