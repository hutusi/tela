/**
 * `/login`: the front door as a page (ADRs 0024, 0036), where a page only members see sends a
 * visitor with `?next=`, and where the mails' links land. The sign-in mail's link,
 * `/login?email=…&otp=…`, and the reset mail's, `/login?reset=1&email=…&otp=…`, only fill the
 * code in: the page names the account and waits for a press. Google and GitHub come back here
 * with `?error=` when tela-api has no other page to send them to. Each is taken out of the address
 * bar as soon as it is read.
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { DoorForm } from '../components/front-door'
import { LogoMark } from '../components/logo'
import { VisitorLocale } from '../components/visitor-locale'
import {
  loginPath,
  type MailLink,
  mailLink,
  NEWCOMER,
  type Provider,
  providerError,
  type SignInError,
  safeNext,
} from '../lib/use-sign-in'

type Arrival = { link: MailLink | null; error: SignInError | null }

function arrivalOf(search: URLSearchParams): Arrival {
  const error = search.get('error')
  return { link: mailLink(search), error: error ? providerError(error) : null }
}

/** Where a refused Google or GitHub sign-in started here comes back to: this page, as it was. */
function loginReturn(next: string, provider: Provider): string {
  const params = new URLSearchParams({ via: provider })
  if (next !== safeNext(null)) params.set('next', next)
  return `/login?${params}`
}

export function LoginPage() {
  const t = useTranslations('login')
  const [search] = useSearchParams()
  const next = safeNext(search.get('next'))
  const [arrival, setArrival] = useState(() => arrivalOf(search))

  // Take the code or the error out of the address bar at once, and keep it here. A link followed
  // inside a page already open here comes through too, as a fresh form.
  useEffect(() => {
    const now = arrivalOf(search)
    if (!now.link && !now.error) return
    window.history.replaceState(window.history.state, '', loginPath(search))
    setArrival(now)
  }, [search])

  const link = arrival.link
  return (
    <>
      <header className="flex h-14 items-center justify-between gap-2.5 border-b border-line px-4 lg:px-7">
        <Link
          to="/"
          className="flex items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
        >
          <LogoMark />
          <span>Tela</span>
        </Link>
        <VisitorLocale className="flex shrink-0" />
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col px-6 py-16 animate-fade">
        <DoorForm
          key={link ? `${link.reset ? 'reset' : 'link'} ${link.email} ${link.otp}` : 'form'}
          mode="login"
          place="page"
          title={t('title')}
          next={next}
          newcomer={NEWCOMER}
          errorReturn={(provider) => loginReturn(next, provider)}
          link={link}
          error={arrival.error}
          replace
        />
      </main>
    </>
  )
}
