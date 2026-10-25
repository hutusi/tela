/**
 * Text and attribute values for the XML Tela writes (OPML, RSS). Escaping alone is not enough: XML
 * 1.0 cannot hold most control characters, a lone surrogate or U+FFFE and U+FFFF, not even as a
 * reference, and a feed title carrying one (they arrive from feeds) would leave the whole document
 * unreadable. Those are dropped; everything else is kept, the five specials escaped.
 */

/**
 * What XML 1.0 cannot hold, or should not: control characters but tab and the two line breaks
 * (U+007F to U+009F among them, which it allows and nothing means), lone surrogates and the last
 * two code points of the first plane.
 */
const NOT_XML = /[^\P{Cc}\t\n\r]|\p{Cs}|[\u{FFFE}\u{FFFF}]/gu

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/** `s` as element text or an attribute value, either quote. */
export function xmlEscape(s: string): string {
  return s.replace(NOT_XML, '').replace(/[&<>"']/g, (c) => ENTITIES[c] as string)
}

/**
 * Plain text where a feed reader expects HTML (an RSS `description`): escaped for HTML, then for
 * XML, so `<b>` in an excerpt reads as the three characters it is and never as markup.
 */
export function xmlEscapeHtmlText(s: string): string {
  return xmlEscape(s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')))
}
