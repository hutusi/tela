/**
 * The mails Tela sends a member. Two carry a code: one to sign in, one to choose a new password.
 * Each leads with the code, in both UI languages, because the member may open it on another
 * device than the one waiting for it (ADR 0013). The link carries the same code, so whichever
 * device opens it can finish there. The rest are notices about the account's ways in, which
 * carry no code and sign nobody in (ADR 0036).
 *
 * The words are in catalogues, one per language (`mail-text/*.json`), with `{to}`, `{provider}`
 * and `{login}` filled in here. Besides each mail's lines, a catalogue says how its language puts
 * them together: `between` goes between two sentences (a space, or nothing in Chinese), and
 * `colon` ends the line before the link.
 */
import type { MailMessage } from '@tela/platform'
import en from './mail-text/en.json'
import zhHans from './mail-text/zh-Hans.json'

/** One language's mail text. Every catalogue has the English one's shape. */
type MailText = typeof en

/** The languages a mail is written in, in the order it shows them: English, then Simplified. */
const LANGUAGES: readonly [MailText, MailText] = [en, zhHans]

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** What a catalogue's `{name}`s stand for in one mail. */
type Values = Readonly<Record<string, string>>

/** A catalogue line with its `{name}`s filled in. A name the mail has no value for is a bug. */
function fill(line: string, values: Values): string {
  return line.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`mail text: nothing to fill {${name}} with`)
    return value
  })
}

/** A line in each language: one line each in the text, one paragraph in HTML. */
type Both = readonly [first: string, second: string]

/** The same line in both languages, read from each catalogue and filled in. */
const both = (line: (text: MailText) => string, values: Values = {}): Both => [
  fill(line(LANGUAGES[0]), values),
  fill(line(LANGUAGES[1]), values),
]

/** A line said in both languages on one line, as subjects and headings are. */
const together = ([first, second]: Both) => `${first} · ${second}`

/** Sentences of each language, in turn, made one line in each. */
const sentences = (...lines: Both[]): Both => [
  lines.map((line) => line[0]).join(LANGUAGES[0].between),
  lines.map((line) => line[1]).join(LANGUAGES[1].between),
]

const paragraph = ([first, second]: Both) => `${escapeHtml(first)}<br>${escapeHtml(second)}`

/** A code's mail: the heading, what the code is for, the code, its link, and what else to know. */
function codeMail(options: {
  to: string
  subject: string
  heading: string
  intro: Both
  code: string
  link: string
  outro: Both
}): MailMessage {
  const { to, subject, heading, intro, code, link, outro } = options
  const openLink = `${together(both((t) => t.openLink))}${LANGUAGES[1].colon}`
  const lines = [heading, '', ...intro, '', code, '', openLink, link, '', ...outro]
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2a24">
<h1 style="font-size:18px">${escapeHtml(heading)}</h1>
<p>${paragraph(intro)}</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>
<p>${escapeHtml(openLink)}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p style="color:#667">${paragraph(outro)}</p>
</body></html>`
  return { to, subject, text: lines.join('\n'), html }
}

export function signInMail(options: {
  to: string
  code: string
  publicUrl: string
  /**
   * A first sign-in, which the mail calls an invitation: an address joining with an invite, or an
   * account the operator made that has not signed in yet.
   */
  invited: boolean
}): MailMessage {
  const { to, code, publicUrl, invited } = options
  const kind = (t: MailText) => (invited ? t.invited : t.signIn)
  return codeMail({
    to,
    code,
    subject: `${together(both((t) => kind(t).subject))}: ${code}`,
    heading: together(both((t) => kind(t).heading)),
    intro: both((t) => t.signIn.intro),
    link: `${publicUrl}/login?email=${encodeURIComponent(to)}&otp=${encodeURIComponent(code)}`,
    outro: both((t) => t.signIn.outro),
  })
}

/**
 * A code to choose a new password (ADR 0036), which also gives a member who never had one their
 * first. Its link asks for the new password; nothing in it signs anyone in. Like the sign-in mail,
 * the subject ends with the code.
 */
export function passwordResetMail(options: {
  to: string
  code: string
  publicUrl: string
}): MailMessage {
  const { to, code, publicUrl } = options
  return codeMail({
    to,
    code,
    subject: `${together(both((t) => t.reset.subject))}: ${code}`,
    heading: together(both((t) => t.reset.heading)),
    intro: both((t) => t.reset.intro),
    link: `${publicUrl}/login?reset=1&email=${encodeURIComponent(to)}&otp=${encodeURIComponent(code)}`,
    outro: both((t) => t.reset.outro),
  })
}

/** A notice: the heading, what happened, and what to do if it was not the member. */
function noticeMail(options: {
  to: string
  subject: string
  heading: string
  what: Both
  ifNot: Both
}): MailMessage {
  const { to, subject, heading, what, ifNot } = options
  const lines = [heading, '', ...what, '', ...ifNot]
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2a24">
<h1 style="font-size:18px">${escapeHtml(heading)}</h1>
<p>${paragraph(what)}</p>
<p>${paragraph(ifNot)}</p>
</body></html>`
  return { to, subject, text: lines.join('\n'), html }
}

/** How a provider is named to a member: `GitHub`, never `github`. */
const PROVIDER_NAMES: Record<string, string> = { google: 'Google', github: 'GitHub' }

/**
 * An account made through Google or GitHub (ADR 0036), told to the address it was made for. The
 * provider vouched for the address, but a provider's word says the address was proved once, not
 * who holds it today: an owner who did not make the account signs in by code, which proves the
 * address now, and takes the provider off it.
 */
export function providerAccountMail(options: {
  to: string
  provider: string
  publicUrl: string
}): MailMessage {
  const { to, publicUrl } = options
  const provider = PROVIDER_NAMES[options.provider] ?? options.provider
  const values = { to, provider, login: `${publicUrl}/login` }
  return noticeMail({
    to,
    subject: together(both((t) => t.providerAccount.subject, values)),
    heading: together(both((t) => t.providerAccount.heading)),
    what: sentences(
      both((t) => t.providerAccount.what, values),
      both((t) => t.notice.ifYou),
    ),
    ifNot: both((t) => t.providerAccount.ifNot, values),
  })
}

/** A change to a member's ways in (ADR 0036): a password, or a provider linked or removed. */
export type AccountChange =
  | { kind: 'password-set' | 'password-changed' | 'password-reset' }
  | { kind: 'linked' | 'unlinked'; provider: string }

/** The changes that also end the member's other sessions, which the notice says. */
const ENDS_OTHER_SESSIONS = new Set<AccountChange['kind']>([
  'password-set',
  'password-changed',
  'linked',
])

/**
 * A change to the ways into a member's account (ADR 0036), told to their address whoever made it,
 * so a way in that someone else added, or one of the member's they took away, does not go
 * unnoticed. What to do if it was not the member depends on what changed: a password is replaced
 * by a reset code, which ends every session; a provider is removed after signing in by code, which
 * proves the address today. Like every notice, it carries no code and signs nobody in.
 */
export function accountChangeMail(options: {
  to: string
  change: AccountChange
  publicUrl: string
}): MailMessage {
  const { to, change, publicUrl } = options
  const provider = 'provider' in change ? (PROVIDER_NAMES[change.provider] ?? change.provider) : ''
  const values = { to, provider, login: `${publicUrl}/login` }
  const { kind } = change
  const othersOut = ENDS_OTHER_SESSIONS.has(kind) ? [both((t) => t.notice.othersOut)] : []
  return noticeMail({
    to,
    subject: together(both((t) => t.accountChange[kind].subject, values)),
    heading: together(both((t) => t.accountChange.heading)),
    what: sentences(
      both((t) => t.accountChange[kind].what, values),
      ...othersOut,
      both((t) => t.notice.ifYou),
    ),
    ifNot: both(
      (t) =>
        kind === 'password-set' || kind === 'password-changed'
          ? t.accountChange.newPassword
          : t.accountChange[kind].ifNot,
      values,
    ),
  })
}
