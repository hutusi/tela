/**
 * What breaks in this browser, told to tela-api's logs (`POST /api/client-errors`): a render an
 * error boundary caught or none did (`createRoot`'s `onCaughtError` and `onUncaughtError`), an
 * error or rejection the page left unhandled, a boot that failed, and a content security policy
 * violation (ADR 0051).
 *
 * Only Tela's own: an unhandled error or rejection is reported only when its stack runs through
 * the app's scripts (`/assets/…` once built, `/src/…` under Vite), so an extension's errors, a
 * cross-origin "Script error." and an aborted fetch's bare DOMException say nothing; nor does a
 * violation an extension's own script set off. At most five reports a page load and three
 * violations, each told once, and never a query string: `/join?code=…` is someone's.
 */

import { withoutQueries } from '@tela/shared'

export type ReportKind = 'boundary' | 'error' | 'rejection' | 'boot' | 'csp'

export const REPORTS_PER_LOAD = 5
/**
 * Policy violations have a budget of their own, here and at tela-api (`clientCsp`): an extension
 * that injects scripts sets them off on every page, and must not use up what a real error needs.
 */
export const CSP_REPORTS_PER_LOAD = 3
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

/** An address of a browser extension's own: what it sets off is not Tela's to report. */
const EXTENSION = /^(chrome|moz|safari-web|ms-browser)-extension:/

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
  // The kind rides in a header too, so tela-api counts a violation apart before reading the body.
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tela-report': body.kind },
    body: JSON.stringify(body),
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined)
}

/**
 * One page load's reporter: deduplicated, and capped at `REPORTS_PER_LOAD`, with violations
 * counted apart (`CSP_REPORTS_PER_LOAD`).
 */
export function reporter(send: Send = sendByFetch, path: () => string = () => location.pathname) {
  const told = new Set<string>()
  const sent = { errors: 0, csp: 0 }
  return function report(kind: ReportKind, error: unknown): void {
    const err = error instanceof Error ? error : null
    const message = withoutQueries(
      (err ? `${err.name}: ${err.message}` : String(error)).slice(0, MESSAGE_MAX),
    )
    const stack = err?.stack ? withoutQueries(err.stack).slice(0, STACK_MAX) : undefined
    const key = `${kind}\n${message}\n${stack?.split('\n')[1] ?? ''}`
    const budget = kind === 'csp' ? 'csp' : 'errors'
    const cap = kind === 'csp' ? CSP_REPORTS_PER_LOAD : REPORTS_PER_LOAD
    if (told.has(key) || sent[budget] >= cap) return
    told.add(key)
    sent[budget] += 1
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
    if (EXTENSION.test(event.sourceFile) || EXTENSION.test(event.blockedURI)) return
    const blocked = withoutQueries(event.blockedURI || 'inline')
    tell('csp', `${event.effectiveDirective} ${blocked}`)
  })
}
