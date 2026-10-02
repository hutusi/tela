/**
 * The one mail Tela sends a member: a sign-in code. It leads with the code, in both UI languages,
 * because the member may open it on another device than the one waiting for it (ADR 0013). The
 * link carries the same code, so it signs in whichever device opens it.
 */
import type { MailMessage } from '@tela/platform'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

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
  const link = `${publicUrl}/login?email=${encodeURIComponent(to)}&otp=${encodeURIComponent(code)}`
  const heading = invited
    ? 'You are invited to Tela · 邀请你加入 Tela'
    : 'Sign in to Tela · 登录 Tela'
  const subject = invited
    ? `You are invited to Tela · 邀请你加入 Tela: ${code}`
    : `Your Tela sign-in code · Tela 登录验证码: ${code}`
  const lines = [
    heading,
    '',
    'Enter this code to sign in. It expires in one hour.',
    '输入下面的验证码登录，一小时内有效。',
    '',
    code,
    '',
    'Or open this link in your browser · 或在浏览器中打开此链接：',
    link,
    '',
    'If you did not ask for this, you can ignore this email.',
    '如果这不是你本人的操作，请忽略这封邮件。',
  ]
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2a24">
<h1 style="font-size:18px">${escapeHtml(heading)}</h1>
<p>Enter this code to sign in. It expires in one hour.<br>输入下面的验证码登录，一小时内有效。</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>
<p>Or open this link in your browser · 或在浏览器中打开此链接：<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p style="color:#667">If you did not ask for this, you can ignore this email.<br>如果这不是你本人的操作，请忽略这封邮件。</p>
</body></html>`
  return { to, subject, text: lines.join('\n'), html }
}
