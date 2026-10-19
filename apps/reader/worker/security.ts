/**
 * The headers every page of Tela carries (ADR 0051), in one place: `public/_headers` gives them to
 * what the asset router serves (the shell, at any path it answers with the app), and the edge sets
 * them on every HTML answer it builds (`withSecurityHeaders`). `test/security.test.ts` holds
 * `_headers` to this, and the theme script's hash to `index.html`.
 */

/**
 * The one inline script, `index.html`'s theme before first paint, by its hash: no `unsafe-inline`
 * for scripts. Change a byte of that script and this hash must change with it, which the test
 * says. The edge's `#tela-data` handover is `application/json`, which is never run, so it needs
 * none.
 */
export const THEME_SCRIPT_HASH = 'sha256-iu96BVO3nRFhZTCHPNdC3hcRMXDyiUs6Q6h1Z9Lp6fA='

/**
 * Report-only for now: a violation fires the page's `securitypolicyviolation` event and nothing is
 * blocked, until a week with none reported says it can be enforced.
 * Styles need `'unsafe-inline'`: the views set `style` attributes, which the edge renders into
 * the HTML, and the app mounts over them without hydrating.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${THEME_SCRIPT_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://assets.telaread.com blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Not `upgrade-insecure-requests` yet: a report-only policy cannot upgrade anything, and
  // browsers say so in the console on every page. It joins when the policy is enforced.
].join('; ')

/**
 * Enforced from the start, all but the CSP. HSTS without `includeSubDomains` until every
 * subdomain is known to serve HTTPS.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy-report-only': CONTENT_SECURITY_POLICY,
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'x-frame-options': 'DENY',
}

/** `response` with the security headers set, made mutable first if it came from a fetch. */
export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value)
  return out
}
