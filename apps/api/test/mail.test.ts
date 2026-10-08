/**
 * The mails Tela sends (`src/mail.ts`), in each language, and how a mail picks its language
 * (`src/mail-locale.ts`). The English ones are pinned byte for byte in
 * `__snapshots__/mail.test.ts.snap`, recorded from the mails as they were written before their
 * text moved into catalogues: a change to what an English reader receives shows up there as a diff.
 */
import { describe, expect, test } from 'bun:test'
import type { MailMessage } from '@tela/platform'
import { UI_LOCALES, type UiLocale } from '@tela/shared'
import { accountChangeMail, passwordResetMail, providerAccountMail, signInMail } from '../src/mail'
import { languageHeaders, mailLocale } from '../src/mail-locale'
import en from '../src/mail-text/en.json'
import fr from '../src/mail-text/fr.json'
import zhHans from '../src/mail-text/zh-Hans.json'
import zhHant from '../src/mail-text/zh-Hant.json'

const PUBLIC_URL = 'https://tela.example'
/** An address with characters the HTML must escape and the link must encode. */
const TO = "o'neil+tela@x.test"
const CODE = '123456'

type Kind = 'code' | 'notice'

/** Every mail Tela sends, by a name of its own, in `locale`. */
function everyMail(locale: UiLocale): [string, Kind, MailMessage][] {
  const base = { to: TO, publicUrl: PUBLIC_URL, locale }
  const notice = (change: Parameters<typeof accountChangeMail>[0]['change']) =>
    accountChangeMail({ ...base, change })
  return [
    ['sign-in', 'code', signInMail({ ...base, code: CODE, invited: false })],
    ['invited', 'code', signInMail({ ...base, code: CODE, invited: true })],
    ['password reset code', 'code', passwordResetMail({ ...base, code: CODE })],
    ['account made with GitHub', 'notice', providerAccountMail({ ...base, provider: 'github' })],
    [
      'account made with a provider Tela has no name for',
      'notice',
      providerAccountMail({ ...base, provider: 'other' }),
    ],
    ['password set', 'notice', notice({ kind: 'password-set' })],
    ['password changed', 'notice', notice({ kind: 'password-changed' })],
    ['password reset', 'notice', notice({ kind: 'password-reset' })],
    ['Google linked', 'notice', notice({ kind: 'linked', provider: 'google' })],
    ['GitHub removed', 'notice', notice({ kind: 'unlinked', provider: 'github' })],
  ]
}

const OTHERS = UI_LOCALES.filter((locale) => locale !== 'en')
const lines = (mail: MailMessage) => mail.text.split('\n')

describe('the English mails', () => {
  for (const [name, , mail] of everyMail('en')) {
    test(`${name} is what it has always been`, () => {
      expect(mail).toMatchSnapshot()
    })
  }
})

describe("a sign-in code's link", () => {
  test('asks for a password only on a first sign-in (ADR 0043)', () => {
    const link = (invited: boolean) =>
      lines(signInMail({ to: TO, code: CODE, publicUrl: PUBLIC_URL, locale: 'en', invited })).find(
        (line) => line.startsWith(`${PUBLIC_URL}/login?`),
      )
    expect(link(true)).toBe(`${PUBLIC_URL}/login?email=o'neil%2Btela%40x.test&otp=${CODE}&join=1`)
    expect(link(false)).toBe(`${PUBLIC_URL}/login?email=o'neil%2Btela%40x.test&otp=${CODE}`)
  })
})

describe('a mail in another language', () => {
  test('leads with that language, with English second', () => {
    const base = (locale: UiLocale) => ({ to: TO, code: CODE, publicUrl: PUBLIC_URL, locale })
    const subject = (locale: UiLocale) => signInMail({ ...base(locale), invited: false }).subject
    expect(subject('zh-Hans')).toBe('Tela 登录验证码 · Your Tela sign-in code: 123456')
    expect(subject('zh-Hant')).toBe('Tela 登入驗證碼 · Your Tela sign-in code: 123456')
    expect(subject('fr')).toBe('Votre code de connexion à Tela · Your Tela sign-in code: 123456')

    const french = signInMail({ ...base('fr'), invited: true })
    expect(french.subject).toBe(
      'Votre invitation à rejoindre Tela · You are invited to Tela: 123456',
    )
    expect(lines(french)).toEqual([
      'Votre invitation à rejoindre Tela · You are invited to Tela',
      '',
      'Saisissez ce code pour vous connecter. Il expire dans une heure.',
      'Enter this code to sign in. It expires in one hour.',
      '',
      CODE,
      '',
      'Ou ouvrez ce lien dans votre navigateur · Or open this link in your browser:',
      // A first sign-in's link asks for a password (ADR 0043).
      `${PUBLIC_URL}/login?email=o'neil%2Btela%40x.test&otp=${CODE}&join=1`,
      '',
      'Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.',
      'If you did not ask for this, you can ignore this email.',
    ])

    const traditional = accountChangeMail({
      to: TO,
      publicUrl: PUBLIC_URL,
      locale: 'zh-Hant',
      change: { kind: 'linked', provider: 'github' },
    })
    expect(traditional.subject).toBe(
      'GitHub 已連結到你的 Tela 帳號 · GitHub was linked to your Tela account',
    )
    expect(lines(traditional)).toEqual([
      '你的 Tela 登入方式有變動 · How you sign in to Tela changed',
      '',
      `現在可以用 GitHub 登入 ${TO} 的 Tela 帳號。其他裝置都已登出。如果是你本人，無需任何操作。`,
      `GitHub now signs in to the Tela account for ${TO}. Every other device was signed out. If that was you, there is nothing to do.`,
      '',
      `如果不是你本人，請在 ${PUBLIC_URL}/login 用寄到這個信箱的驗證碼登入，然後在「設定 → 帳戶」中移除 GitHub，並登出所有裝置。`,
      `If it was not you, sign in at ${PUBLIC_URL}/login with a code sent to this address, then remove GitHub and sign out everywhere in Settings → Account.`,
    ])
  })

  for (const locale of OTHERS) {
    test(`in ${locale}, carries the English mail's English as its second language, in every mail`, () => {
      const english = everyMail('en')
      everyMail(locale).forEach(([name, kind, mail], i) => {
        const [, , them] = english[i] ?? []
        if (!them) throw new Error(`no English ${name}`)
        // Each pair is [English, Simplified] in an English mail, and [own, English] here.
        const englishOf = (line: string) => line.split(' · ')[0]
        const pairs = kind === 'code' ? [2, 10] : [2, 5]
        expect(mail.subject.split(' · ')[1]).toBe(
          kind === 'code' ? `${englishOf(them.subject)}: ${CODE}` : englishOf(them.subject),
        )
        expect(lines(mail)[0]?.split(' · ')[1]).toBe(englishOf(lines(them)[0] ?? ''))
        for (const at of pairs) {
          expect(lines(mail)[at + 1]).toBe(lines(them)[at] ?? '')
          expect(lines(mail)[at]).not.toBe(lines(them)[at])
        }
        expect(lines(mail)).toHaveLength(lines(them).length)
      })
    })
  }

  test('fills every placeholder, in every language and every part', () => {
    for (const locale of UI_LOCALES) {
      for (const [name, , mail] of everyMail(locale)) {
        for (const part of [mail.subject, mail.text, mail.html ?? '']) {
          if (/\{\w*\}/.test(part)) throw new Error(`${locale} ${name}: ${part}`)
        }
        expect(mail.text).toContain('Tela')
      }
    }
  })

  test('in French carries no Chinese', () => {
    for (const [name, , mail] of everyMail('fr')) {
      const text = `${mail.subject}\n${mail.text}\n${mail.html}`
      if (/\p{Script=Han}/u.test(text)) throw new Error(`fr ${name} has Chinese in it`)
    }
  })

  test('in Traditional Chinese carries none of the Simplified-only characters the Simplified one has', () => {
    // The characters of the Simplified mails that OpenCC changes (`toTraditional(c) !== c`),
    // listed once since tela-api does not depend on `@tela/llm`. Each is checked to be in the
    // Simplified mails, so the list cannot go stale and check nothing.
    const simplifiedOnly = [
      ...'浏览开链录验证码输时内这请邮设后备会变无账号过创个属于发户并动页说读护关联现从',
    ]
    const all = (locale: UiLocale) =>
      everyMail(locale)
        .map(([, , m]) => `${m.subject}\n${m.text}\n${m.html}`)
        .join('\n')
    const simplified = all('zh-Hans')
    const traditional = all('zh-Hant')
    for (const c of simplifiedOnly) expect(simplified).toContain(c)
    expect(traditional).toMatch(/\p{Script=Han}/u)
    expect(simplifiedOnly.filter((c) => traditional.includes(c))).toEqual([])
  })

  test('catalogues have the same lines and the same placeholders in each language', () => {
    const shape = (text: unknown, path = ''): string[] =>
      typeof text === 'string'
        ? [`${path} ${(text.match(/\{\w+\}/g) ?? []).sort().join(' ')}`]
        : Object.entries(text as object).flatMap(([key, value]) => shape(value, `${path}.${key}`))
    for (const text of [zhHans, zhHant, fr]) expect(shape(text)).toEqual(shape(en))
  })
})

describe('which language a mail is in', () => {
  test('the language cookie, then the account, then the browser, then English', () => {
    const cookie = 'tela.session_token=abc; tela_locale=fr; theme=dark'
    const acceptLanguage = 'zh-TW,zh;q=0.9,en;q=0.8'
    expect(mailLocale({ cookie, acceptLanguage, account: 'zh-Hans' })).toBe('fr')
    expect(mailLocale({ cookie: 'theme=dark', acceptLanguage, account: 'zh-Hans' })).toBe('zh-Hans')
    expect(mailLocale({ cookie: 'theme=dark', acceptLanguage, account: null })).toBe('zh-Hant')
    expect(mailLocale({ acceptLanguage: 'fr-CA,en;q=0.5' })).toBe('fr')
    expect(mailLocale({ acceptLanguage: 'de-DE,ja' })).toBe('en')
    expect(mailLocale({})).toBe('en')
  })

  test('a cookie or an account language Tela does not have is no choice', () => {
    for (const cookie of ['tela_locale=de', 'tela_locale=%E4', 'tela_locale=', 'xtela_locale=fr']) {
      expect(mailLocale({ cookie, acceptLanguage: 'zh-CN' })).toBe('zh-Hans')
    }
    expect(mailLocale({ cookie: 'tela_locale=zh-Hant' })).toBe('zh-Hant')
    expect(mailLocale({ cookie: 'tela_locale=zh%2DHant' })).toBe('zh-Hant')
    expect(mailLocale({ account: 'ja', acceptLanguage: 'fr' })).toBe('fr')
  })

  test("only the language cookie and Accept-Language of a joiner's request are passed on", () => {
    const passed = languageHeaders(
      new Headers({
        cookie: 'tela.session_token=secret; tela_locale=zh-Hant; other=1',
        'accept-language': 'fr',
        'cf-connecting-ip': '198.51.100.1',
        origin: PUBLIC_URL,
      }),
    )
    expect([...passed.entries()]).toEqual([
      ['accept-language', 'fr'],
      ['cookie', 'tela_locale=zh-Hant'],
    ])
    expect([...languageHeaders(new Headers({ 'cf-connecting-ip': '1' })).entries()]).toEqual([])
  })
})
