/**
 * Reporting what a public page shows (ADR 0059): a member sends a report to tela-api; a visitor,
 * who has no account to send one with, gets a mail to the contact address with the page's address
 * in it. Both are built from the page's own canonical path, never from the address the browser
 * asked for, so the edge renders the same link for every visitor, cached or not, and the app
 * renders the same one again over it.
 */
import {
  REPORT_ADDRESS,
  REPORT_DETAILS_MAX,
  type ReportReason,
  type ReportTarget,
} from '@tela/shared'
import { apiJson } from '../store/api'

/** Tela's one public origin (ADR 0042): what a visitor's mail names the page by. */
export const PUBLIC_ORIGIN = 'https://telaread.com'

/** What a report names: a kind and its key (`reportKeyOf` in @tela/shared reads it back). */
export type ReportSubject = { kind: ReportTarget; key: string }

/** A visitor's report: a mail to the contact address, its subject given, its body the page. */
export function reportMailto(subject: string, path: string): string {
  const query = new URLSearchParams({ subject, body: `${PUBLIC_ORIGIN}${path}` })
  // URLSearchParams writes a space as `+`, which a mail client shows as a plus.
  return `mailto:${REPORT_ADDRESS}?${query.toString().replace(/\+/g, '%20')}`
}

/**
 * The page a member's report names, kept beside it for the operator: as the browser has it, or
 * with no query or fragment where the query is not the page's to share. On `/connect` it is the
 * app's authorization request, its `state` among it (ADR 0067).
 */
export function reportedAddress(
  at: Pick<Location, 'href' | 'origin' | 'pathname'>,
  withoutQuery: boolean,
): string {
  return withoutQuery ? `${at.origin}${at.pathname}` : at.href
}

/** How many characters the details hold, as tela-api counts them: in code points. */
export const detailsLength = (text: string) => [...text.trim()].length

export const detailsFit = (text: string) => detailsLength(text) <= REPORT_DETAILS_MAX

export type ReportOutcome = 'sent' | 'rate_limited' | 'not_found' | 'failed'

/**
 * Send a member's report. `url` is the page as the browser has it, kept beside the report for the
 * operator; one too long for tela-api to keep is sent as the page's own address instead.
 */
export async function sendReport(input: {
  subject: ReportSubject
  reason: ReportReason
  details: string
  path: string
  url: string
}): Promise<ReportOutcome> {
  const details = input.details.trim()
  const url = input.url.length <= 1000 ? input.url : `${PUBLIC_ORIGIN}${input.path}`
  try {
    const { status } = await apiJson('/api/v1/reports', {
      body: {
        targetKind: input.subject.kind,
        targetKey: input.subject.key,
        reason: input.reason,
        ...(details ? { details } : {}),
        ...(/^https?:\/\//.test(url) ? { url } : {}),
      },
    })
    if (status === 200) return 'sent'
    if (status === 429) return 'rate_limited'
    if (status === 404) return 'not_found'
    return 'failed'
  } catch {
    // Offline, or the session ended: the sync hears of a 401 and a changed account on its own.
    return 'failed'
  }
}
