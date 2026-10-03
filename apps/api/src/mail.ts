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
      `如果不是你本人，这个账号仍然属于你：在 ${publicUrl}/login 用发到此邮箱的验证码登录，然后在“设置 → 账户”中移除 ${provider}，并退出所有设备。`,
    ],
  })
}

/** A change to a member's ways in (ADR 0036): a password, or a provider linked or removed. */
export type AccountChange =
  | { kind: 'password-set' | 'password-changed' | 'password-reset' }
  | { kind: 'linked' | 'unlinked'; provider: string }

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
  const login = `${publicUrl}/login`
  const othersOut: Both = ['Every other device was signed out.', '其他设备都已退出登录。']
  const byCode: Both = [
    `sign in at ${login} with a code sent to this address`,
    `在 ${login} 用发到此邮箱的验证码登录`,
  ]
  const newPassword: Both = [
    `If it was not you, choose a new password from the sign-in page, ${login}: a code comes to this address, and the new password signs everyone else out.`,
    `如果不是你本人，请在登录页 ${login} 重新设置密码：验证码会发到此邮箱，设置新密码后其他人都会退出登录。`,
  ]
  const notes: Record<AccountChange['kind'], { subject: string; what: Both; ifNot: Both }> = {
    'password-set': {
      subject: 'A password was added to your Tela account · 你的 Tela 账号已设置密码',
      what: [
        `The Tela account for ${to} now has a password. ${othersOut[0]}`,
        `${to} 的 Tela 账号已设置密码。${othersOut[1]}`,
      ],
      ifNot: newPassword,
    },
    'password-changed': {
      subject: 'Your Tela password was changed · 你的 Tela 密码已更改',
      what: [
        `The password of the Tela account for ${to} was changed. ${othersOut[0]}`,
        `${to} 的 Tela 账号密码已更改。${othersOut[1]}`,
      ],
      ifNot: newPassword,
    },
    'password-reset': {
      subject: 'Your Tela password was reset · 你的 Tela 密码已重置',
      what: [
        `A new password was chosen for the Tela account for ${to}, with a code sent to this address, and every device was signed out.`,
        `${to} 的 Tela 账号已用发到此邮箱的验证码设置了新密码，所有设备都已退出登录。`,
      ],
      ifNot: [
        `If it was not you, someone can read this mailbox: secure it first, then choose a new password again at ${login}.`,
        `如果不是你本人，说明有人能读取这个邮箱：请先保护好邮箱，再到 ${login} 重新设置密码。`,
      ],
    },
    linked: {
      subject: `${provider} was linked to your Tela account · ${provider} 已关联到你的 Tela 账号`,
      what: [
        `${provider} now signs in to the Tela account for ${to}. ${othersOut[0]}`,
        `现在可以用 ${provider} 登录 ${to} 的 Tela 账号。${othersOut[1]}`,
      ],
      ifNot: [
        `If it was not you, ${byCode[0]}, then remove ${provider} and sign out everywhere in Settings → Account.`,
        `如果不是你本人，请${byCode[1]}，然后在“设置 → 账户”中移除 ${provider}，并退出所有设备。`,
      ],
    },
    unlinked: {
      subject: `${provider} was removed from your Tela account · ${provider} 已从你的 Tela 账号移除`,
      what: [
        `${provider} no longer signs in to the Tela account for ${to}.`,
        `${provider} 不能再登录 ${to} 的 Tela 账号。`,
      ],
      ifNot: [
        `If it was not you, someone is signed in as you: ${byCode[0]}, then sign out everywhere in Settings → Account, and link ${provider} again.`,
        `如果不是你本人，说明有人以你的身份登录了：请${byCode[1]}，然后在“设置 → 账户”中退出所有设备，并重新关联 ${provider}。`,
      ],
    },
  }
  const { subject, what, ifNot } = notes[change.kind]
  return noticeMail({
    to,
    subject,
    heading: 'How you sign in to Tela changed · 你的 Tela 登录方式有变动',
    what: [
      `${what[0]} If that was you, there is nothing to do.`,
      `${what[1]}如果是你本人，无需任何操作。`,
    ],
    ifNot,
  })
}
