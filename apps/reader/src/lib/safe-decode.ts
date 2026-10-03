/**
 * `decodeURIComponent`, or null where it throws: a `%` without two hex digits after it (`#%`,
 * `/@%`), or escapes that are not UTF-8 (`%E4`). Anything a visitor can put in an address or a
 * cookie is decoded through this, and null is read as a name nothing has. Thrown in a render or an
 * effect, the error empties the app, which has no error boundary; thrown in the edge's Worker, it
 * is Cloudflare's error page.
 */
export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (err) {
    if (err instanceof URIError) return null
    throw err
  }
}
