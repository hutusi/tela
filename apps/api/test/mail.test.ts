/**
 * The mails Tela sends (`src/mail.ts`). The English ones are pinned byte for byte in
 * `__snapshots__/mail.test.ts.snap`, recorded from the mails as they were written before their
 * text moved into catalogues: a change to what an English reader receives shows up there as a diff.
 */
import { describe, expect, test } from 'bun:test'
import type { MailMessage } from '@tela/platform'
import { accountChangeMail, passwordResetMail, providerAccountMail, signInMail } from '../src/mail'

const PUBLIC_URL = 'https://tela.example'
/** An address with characters the HTML must escape and the link must encode. */
const TO = "o'neil+tela@x.test"
const CODE = '123456'

/** Every mail Tela sends, by a name of its own. */
function everyMail(): [string, MailMessage][] {
  const notice = (change: Parameters<typeof accountChangeMail>[0]['change']) =>
    accountChangeMail({ to: TO, change, publicUrl: PUBLIC_URL })
  return [
    ['sign-in', signInMail({ to: TO, code: CODE, publicUrl: PUBLIC_URL, invited: false })],
    ['invited', signInMail({ to: TO, code: CODE, publicUrl: PUBLIC_URL, invited: true })],
    ['password reset code', passwordResetMail({ to: TO, code: CODE, publicUrl: PUBLIC_URL })],
    [
      'account made with GitHub',
      providerAccountMail({ to: TO, provider: 'github', publicUrl: PUBLIC_URL }),
    ],
    [
      'account made with a provider Tela has no name for',
      providerAccountMail({ to: TO, provider: 'other', publicUrl: PUBLIC_URL }),
    ],
    ['password set', notice({ kind: 'password-set' })],
    ['password changed', notice({ kind: 'password-changed' })],
    ['password reset', notice({ kind: 'password-reset' })],
    ['Google linked', notice({ kind: 'linked', provider: 'google' })],
    ['GitHub removed', notice({ kind: 'unlinked', provider: 'github' })],
  ]
}

describe('the English mails', () => {
  for (const [name, mail] of everyMail()) {
    test(`${name} is what it has always been`, () => {
      expect(mail).toMatchSnapshot()
    })
  }
})
