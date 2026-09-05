/**
 * Keep an untrusted "where to go next" value on this origin.
 *
 * Accepts only a path that starts with a single slash and stays on the base origin once the
 * URL parser has had its say, so `//evil.example`, `/\evil.example` (browsers treat the
 * backslash as a slash), and absolute URLs all fall back. The normalized path is returned so
 * stray control characters never reach a Location header.
 */
export function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /^\/[/\\]/.test(value)) {
    return fallback
  }
  let parsed: URL
  try {
    parsed = new URL(value, 'http://tela.invalid')
  } catch {
    return fallback
  }
  if (parsed.origin !== 'http://tela.invalid') return fallback
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}
