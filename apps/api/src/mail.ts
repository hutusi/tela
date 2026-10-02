/**
 * The mails Tela sends a member. Two carry a code: one to sign in, one to choose a new password.
 * Each leads with the code, in both UI languages, because the member may open it on another
 * device than the one waiting for it (ADR 0013). The link carries the same code, so whichever
 * device opens it can finish there. The rest are notices about the account's ways in, which
 * carry no code and sign nobody in (ADR 0036).
 */
import type { MailMessage } from '@tela/platform'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A line in English and the same in Chinese: one line each in the text, one paragraph in HTML. */
type Both = readonly [en: string, zh: string]

const OPEN_LINK = 'Or open this link in your browser · 或在浏览器中打开此链接：'
const both = ([en, zh]: Both) => `${escapeHtml(en)}<br>${escapeHtml(zh)}`

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
  const lines = [heading, '', ...intro, '', code, '', OPEN_LINK, link, '', ...outro]
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2a24">
<h1 style="font-size:18px">${escapeHtml(heading)}</h1>
<p>${both(intro)}</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>
<p>${escapeHtml(OPEN_LINK)}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p style="color:#667">${both(outro)}</p>
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
  return codeMail({
    to,
    code,
    subject: invited
      ? `You are invited to Tela · 邀请你加入 Tela: ${code}`
      : `Your Tela sign-in code · Tela 登录验证码: ${code}`,
    heading: invited ? 'You are invited to Tela · 邀请你加入 Tela' : 'Sign in to Tela · 登录 Tela',
    intro: [
      'Enter this code to sign in. It expires in one hour.',
      '输入下面的验证码登录，一小时内有效。',
    ],
    link: `${publicUrl}/login?email=${encodeURIComponent(to)}&otp=${encodeURIComponent(code)}`,
    outro: [
      'If you did not ask for this, you can ignore this email.',
      '如果这不是你本人的操作，请忽略这封邮件。',
    ],
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
    subject: `Reset your Tela password · 重置 Tela 密码: ${code}`,
    heading: 'Reset your Tela password · 重置 Tela 密码',
    intro: [
      'Enter this code to choose a new password. It expires in one hour, and choosing one signs you out everywhere.',
      '输入下面的验证码设置新密码，一小时内有效。设置后，所有设备都会退出登录。',
    ],
    link: `${publicUrl}/login?reset=1&email=${encodeURIComponent(to)}&otp=${encodeURIComponent(code)}`,
    outro: [
      'If you did not ask for this, you can ignore this email: your password stays as it is.',
      '如果这不是你本人的操作，请忽略这封邮件，你的密码不会改变。',
    ],
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
<p>${both(what)}</p>
<p>${both(ifNot)}</p>
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
  return noticeMail({
    to,
    subject: `Your Tela account was made with ${provider} · 你的 Tela 账号已通过 ${provider} 创建`,
    heading: 'A new Tela account · 新的 Tela 账号',
    what: [
      `Someone joined Tela as ${to}, signing in with ${provider}. If that was you, there is nothing to do.`,
      `有人通过 ${provider} 登录，以 ${to} 加入了 Tela。如果是你本人，无需任何操作。`,
    ],
    ifNot: [
      `If it was not you, the account is still yours: sign in at ${publicUrl}/login with a code sent to this address, then remove ${provider} and sign out everywhere in Settings → Account.`,
      `如果不是你本人，这个账号仍然属于你：在 ${publicUrl}/login 用发到此邮箱的验证码登录，然后在“设置 → 账号”中移除 ${provider}，并退出所有设备。`,
    ],
  })
}
