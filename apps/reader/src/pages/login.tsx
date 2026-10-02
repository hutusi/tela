/**
 * Sign in with an emailed code (ADR 0024). The mail's link, `/login?email=…&otp=…`, carries the
 * same code but only fills it in: the page names the account and waits for a press (ADR 0036). A
 * link that signed in by itself would put whoever opened it into the account of whoever sent it,
 * a login CSRF. The reset link, `/login?reset=1&email=…&otp=…`, waits the same way, with the new
 * password to choose. Registration is closed: an address without an account gets the same answer
 * and no mail, so nothing here can say "no such member".
 */
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { LocaleSwitcher } from '../components/locale-switcher'
import { LogoMark } from '../components/logo'
import { useSession } from '../session'

/** Only same-site paths: `//evil.example` and `/\evil.example` are absolute in a browser. */
export function safeNext(next: string | null, fallback = '/reading'): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

/** What a mailed link carries: a sign-in code, or with `reset=1` a password reset's code. */
export type MailLink = { email: string; otp: string; reset: boolean }

export function mailLink(search: URLSearchParams): MailLink | null {
  const email = search.get('email')
  const otp = search.get('otp')
  if (!email || !otp) return null
  return { email, otp, reset: search.get('reset') === '1' }
}

/** The address bar once a link's code is out of it: only where to go afterwards stays. */
export function loginPath(search: URLSearchParams): string {
  const next = search.get('next')
  return next ? `/login?next=${encodeURIComponent(safeNext(next))}` : '/login'
}

type Step = { kind: 'email' } | { kind: 'code'; email: string } | { kind: 'link'; link: MailLink }
type LoginError =
  | 'invalid_email'
  | 'send_failed'
  | 'bad_code'
  | 'rate_limited'
  | 'reset_failed'
  | 'password_set'

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })

export function LoginPage() {
  const t = useTranslations('login')
  const { status, retrying, signedIn } = useSession()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const next = safeNext(search.get('next'))
  // A link is read on the first render too, so a member's tab shows it rather than leave at once.
  const [step, setStep] = useState<Step>(() => {
    const link = mailLink(search)
    return link ? { kind: 'link', link } : { kind: 'email' }
  })
  const [error, setError] = useState<LoginError | null>(null)
  const [busy, setBusy] = useState(false)
  // Signed in, and waiting for /me to say as whom: the code is spent, so the form stays shut.
  const [signedInWaiting, setSignedInWaiting] = useState(false)
  const connecting = signedInWaiting && retrying
  const [value, setValue] = useState('')

  const enter = async () => {
    const outcome = await signedIn(next)
    if (outcome === 'waiting') setSignedInWaiting(true)
    else if (outcome !== 'reloading') navigate(next, { replace: true })
  }

  const verify = async (email: string, otp: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await post('/api/auth/sign-in/email-otp', { email, otp })
      if (!res.ok) {
        setStep({ kind: 'code', email })
        // Too many tries is not a wrong code: saying so would send the member hunting for typos.
        setError(res.status === 429 ? 'rate_limited' : 'bad_code')
        return
      }
      await enter()
    } finally {
      setBusy(false)
    }
  }

  /** The reset link's code sets the new password; then that password signs in. */
  const resetPassword = async (email: string, otp: string, password: string) => {
    setBusy(true)
    setError(null)
    try {
      const reset = await post('/api/auth/email-otp/reset-password', { email, otp, password })
      if (!reset.ok) {
        setError(reset.status === 429 ? 'rate_limited' : 'reset_failed')
        return
      }
      const res = await post('/api/auth/sign-in/email', { email, password })
      if (!res.ok) {
        // The code is spent and the password set: what is left is signing in, by code for now.
        setStep({ kind: 'email' })
        setValue('')
        setError('password_set')
        return
      }
      await enter()
    } finally {
      setBusy(false)
    }
  }

  // The mail's link: take the code out of the address bar at once, and keep it here until the
  // member presses the button. A link followed inside a page already open here comes through too.
  useEffect(() => {
    const link = mailLink(search)
    if (!link) return
    window.history.replaceState(window.history.state, '', loginPath(search))
    setStep({ kind: 'link', link })
    setValue('')
    setError(null)
  }, [search])

  // A member shown a link stays to answer it: it may be for another account, which is how one
  // switches. Once its code is spent and /me is slow to answer, they go on as before.
  if (status === 'member' && !busy && (step.kind !== 'link' || signedInWaiting)) {
    return <Navigate to={next} replace />
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (step.kind === 'link') {
      const { email, otp, reset } = step.link
      await (reset ? resetPassword(email, otp, value) : verify(email, otp))
      return
    }
    if (step.kind === 'code') {
      await verify(step.email, value.trim())
      return
    }
    const email = value.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('invalid_email')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await post('/api/auth/email-otp/send-verification-otp', {
        email,
        type: 'sign-in',
      })
      if (!res.ok) {
        setError(res.status === 429 ? 'rate_limited' : 'send_failed')
        return
      }
      setStep({ kind: 'code', email })
      setValue('')
    } catch {
      setError('send_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="flex h-14 items-center justify-between border-b border-line px-4 lg:px-7">
        <Link
          to="/"
          className="flex items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
        >
          <LogoMark />
          <span>Tela</span>
        </Link>
        <LocaleSwitcher />
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-8 px-6 py-20 animate-fade">
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
        </div>
        <form
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
          data-testid="login-form"
        >
          {step.kind === 'link' ? (
            <>
              <p className="text-[17px] leading-snug text-ink" data-testid="login-link-as">
                {t.rich(step.link.reset ? 'resetAs' : 'linkAs', {
                  email: step.link.email,
                  b: (chunks) => <b className="font-medium break-all">{chunks}</b>,
                })}
              </p>
              {connecting ? null : (
                <p className="text-sm leading-relaxed text-ink-2">
                  {t(step.link.reset ? 'resetHint' : 'linkHint')}
                </p>
              )}
              {step.link.reset ? (
                <input
                  key="new-password"
                  name="new-password"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t('newPassword')}
                  data-testid="login-new-password"
                  className="rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-muted"
                />
              ) : null}
            </>
          ) : step.kind === 'code' ? (
            <>
              <p className="text-sm text-ink-2">{t('codeSent', { email: step.email })}</p>
              <input
                key="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('codePlaceholder')}
                data-testid="login-code"
                className="rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-lg tracking-widest outline-none focus:border-muted"
              />
            </>
          ) : (
            <input
              key="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('emailPlaceholder')}
              data-testid="login-email"
              className="rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-muted"
            />
          )}
          {connecting ? (
            <p className="text-sm text-ink-2" data-testid="login-connecting">
              {t('connecting')}
            </p>
          ) : error ? (
            <p className="text-sm text-danger">{t(`errors.${error}`)}</p>
          ) : null}
          <button
            type="submit"
            disabled={busy || connecting}
            data-testid="login-submit"
            className="rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          >
            {step.kind === 'link'
              ? t(step.link.reset ? 'resetConfirm' : 'linkConfirm')
              : step.kind === 'code'
                ? t('verify')
                : t('sendCode')}
          </button>
          {step.kind === 'link' && !connecting ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep({ kind: 'email' })
                setValue('')
                setError(null)
              }}
              data-testid="login-link-other"
              className="self-center text-sm text-ink-2 hover:text-ink disabled:opacity-60"
            >
              {t('linkOther')}
            </button>
          ) : null}
        </form>
      </main>
    </>
  )
}
