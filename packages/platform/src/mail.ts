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
 * Resend's HTTP API over fetch, so it runs unchanged on Workers and Node. Delivery to qq.com and
 * 163.com was verified from a Worker (spike S4); SMTP is not needed.
 */
export function resendMail(options: { apiKey: string; from: string; fetch?: typeof fetch }): Mail {
  const doFetch = options.fetch ?? fetch
  return {
    async send(message) {
      const res = await doFetch('https://api.resend.com/emails', {
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
      })
      if (!res.ok) {
        throw new MailError(`Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
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
