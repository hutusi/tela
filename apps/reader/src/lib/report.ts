/**
 * What breaks in this browser, told to tela-api's logs (`POST /api/client-errors`): a render an
 * error boundary caught or none did (`createRoot`'s `onCaughtError` and `onUncaughtError`), an
 * error or rejection the page left unhandled, a boot that failed, and a content security policy
 * violation (ADR 0051).
 *
 * Only Tela's own: an unhandled error or rejection is reported only when its stack runs through
 * the app's scripts (`/assets/…` once built, `/src/…` under Vite), so an extension's errors, a
 * cross-origin "Script error." and an aborted fetch's bare DOMException say nothing. At most five
 * reports a page load, each told once, and never a query string: `/join?code=…` is someone's.
 */

export type ReportKind = 'boundary' | 'error' | 'rejection' | 'boot' | 'csp'

export const REPORTS_PER_LOAD = 5
const ENDPOINT = '/api/client-errors'
/** As tela-api keeps them: anything longer is cut there anyway. */
const MESSAGE_MAX = 1000
const STACK_MAX = 4096

/** The script this build was loaded from, which names the deploy (`index-<hash>.js`). */
const BUILD = (() => {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() ?? ''
  } catch {
    return ''
  }
})()

/** `text` with every query string cut from the addresses in it, as tela-api cuts them too. */
export function withoutQueries(text: string): string {
  return text.replace(/(?<=[\w/.%-])\?[^\s)'"`<>#]*/g, '')
}

/** Whether a stack runs through Tela's own scripts, built or under Vite's dev server. */
export function ours(stack: string | undefined, origin: string): boolean {
  if (!stack) return false
  return stack.includes(`${origin}/assets/`) || stack.includes(`${origin}/src/`)
}

/** One report, as tela-api takes it. */
export type ClientReport = {
  kind: ReportKind
  message: string
  stack?: string
  path: string
  build: string
}

/** Who sends, so a test can count; `fetch` in the browser. */
export type Send = (body: ClientReport) => void

const sendByFetch: Send = (body) => {
  // Keepalive: a report made as the page goes still arrives. Its failure is nobody's to handle.
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined)
}

/** One page load's reporter: deduplicated, and capped at `REPORTS_PER_LOAD`. */
export function reporter(send: Send = sendByFetch, path: () => string = () => location.pathname) {
  const told = new Set<string>()
  let sent = 0
  return function report(kind: ReportKind, error: unknown): void {
    const err = error instanceof Error ? error : null
    const message = withoutQueries(
      (err ? `${err.name}: ${err.message}` : String(error)).slice(0, MESSAGE_MAX),
    )
    const stack = err?.stack ? withoutQueries(err.stack).slice(0, STACK_MAX) : undefined
    const key = `${kind}\n${message}\n${stack?.split('\n')[1] ?? ''}`
    if (told.has(key) || sent >= REPORTS_PER_LOAD) return
    told.add(key)
    sent += 1
    send({ kind, message, ...(stack ? { stack } : {}), path: path(), build: BUILD })
  }
}

/** This page load's reporter. */
export const report = reporter()

/**
 * Listen for what no boundary sees: an error or a rejection the page left unhandled, Tela's own
 * only, and a policy violation. Called once, first thing at boot.
 */
export function watchErrors(target: Window = window, tell = report): void {
  const origin = target.location.origin
  target.addEventListener('error', (event) => {
    const error = event.error as unknown
    if (error instanceof Error && ours(error.stack, origin)) tell('error', error)
  })
  target.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown
    if (reason instanceof Error && ours(reason.stack, origin)) tell('rejection', reason)
  })
  target.document.addEventListener('securitypolicyviolation', (event) => {
    const blocked = withoutQueries(event.blockedURI || 'inline')
    tell('csp', `${event.effectiveDirective} ${blocked}`)
  })
}
