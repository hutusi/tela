/**
 * Sign in with an emailed code (ADR 0024). The mail's link, `/login?email=…&otp=…`, submits the
 * same code on arrival, so it signs in whichever device opens it. Registration is closed: an
 * address without an account gets the same answer and no mail, so nothing here can say "no such
 * member".
 */
import { useEffect, useRef, useState } from 'react'
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

type Step = { kind: 'email' } | { kind: 'code'; email: string }
type LoginError = 'invalid_email' | 'send_failed' | 'bad_code' | 'rate_limited'

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })

export function LoginPage() {
  const t = useTranslations('login')
  const { status, signedIn } = useSession()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const next = safeNext(search.get('next'))
  const [step, setStep] = useState<Step>({ kind: 'email' })
  const [error, setError] = useState<LoginError | null>(null)
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState('')
  const linked = useRef(false)

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
      await signedIn()
      navigate(next, { replace: true })
    } finally {
      setBusy(false)
    }
  }

  // The mail's link: take the code out of the address bar first, then sign in with it.
  useEffect(() => {
    const email = search.get('email')
    const otp = search.get('otp')
    if (!email || !otp || linked.current) return
    linked.current = true
    window.history.replaceState(
      null,
      '',
      `/login${search.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`,
    )
    void verify(email, otp)
  })

  if (status === 'member' && !busy) return <Navigate to={next} replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
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
          {step.kind === 'code' ? (
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
          {error ? <p className="text-sm text-danger">{t(`errors.${error}`)}</p> : null}
          <button
            type="submit"
            disabled={busy}
            data-testid="login-submit"
            className="rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          >
            {step.kind === 'code' ? t('verify') : t('sendCode')}
          </button>
        </form>
      </main>
    </>
  )
}
