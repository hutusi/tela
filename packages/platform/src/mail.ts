export type MailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mail {
  send(message: MailMessage): Promise<void>
}

export class MailError extends Error {
  override name = 'MailError'
}

/**
 * How long Resend has to answer. A sign-in code is mailed while the member waits on the sheet, and
 * a call that never answered held the request until the Worker's own limit ended it, with nothing
 * logged that said why.
 */
export const MAIL_TIMEOUT_MS = 10_000

/**
 * Resend's HTTP API over fetch, so it runs unchanged on Workers and Node. Delivery to qq.com and
 * 163.com was verified from a Worker (spike S4); SMTP is not needed. Every failure, a refusal, a
 * network error or no answer within `timeoutMs`, is a `MailError`.
 */
export function resendMail(options: {
  apiKey: string
  from: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Mail {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? MAIL_TIMEOUT_MS
  return {
    async send(message) {
      // One signal for the request and a refusal's body.
      const signal = AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
          signal,
        })
      } catch (err) {
        const why =
          err instanceof Error && err.name === 'TimeoutError'
            ? `no answer in ${timeoutMs} ms`
            : String(err)
        throw new MailError(`Resend not reached: ${why}`, { cause: err })
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new MailError(`Resend answered ${res.status}: ${detail.slice(0, 200)}`)
      }
    },
  }
}

/** Mail that goes nowhere; tests and a Worker's test mode read the outbox. */
export function memoryMail(): Mail & { readonly outbox: MailMessage[] } {
  const outbox: MailMessage[] = []
  return {
    outbox,
    async send(message) {
      outbox.push(message)
    },
  }
}
