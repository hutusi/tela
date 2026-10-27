/**
 * `/connect`: where a member connects an app to their account (ADR 0064), the authorization
 * endpoint of Tela's OAuth server. The app sends the browser here with its request in the query;
 * tela-api checks it (`GET /api/v1/connect/request`), and the page shows who is asking, for what,
 * and where the answer goes. It always asks, even for an app already connected: a public client
 * id can be used by any program on the computer (RFC 8252 §8.6).
 *
 * - A request tela-api refuses (an unknown app, a redirect it never registered) is said here, and
 *   the browser is never sent anywhere: a bad request could name any address.
 * - Approve or Decline posts the answer, and the browser follows the address tela-api gives back
 *   with `location.assign`, never a form, which the site's `form-action 'self'` would stop.
 * - A visitor signs in through the sheet and stays here (`STAY_PAGES`), a joiner too.
 *
 * The page is the app's alone: the edge never renders it and tela-web never sees it (it is not in
 * `run_worker_first`), so the request in its query reaches no Worker's logs, and the plain shell
 * it is served in says `noindex`.
 */
import type { AppScope, ConnectRequest } from '@tela/shared'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useFrontDoor } from '../components/front-door'
import { MemberLanguage, VisitorLanguage } from '../components/language-menu'
import { LogoMark } from '../components/logo'
import { PersonAvatar } from '../components/person-avatar'
import { askConnect, type ConnectProblem, decideConnect, requestParams } from '../lib/apps-api'
import { useTitle } from '../lib/title'
import { useSession } from '../session'
import { useTables } from '../store/hooks'

const PRIMARY =
  'h-11 rounded-full bg-primary px-5 text-[15px] font-medium text-on-primary hover:brightness-125 disabled:opacity-60'
const QUIET =
  'h-11 rounded-full border border-thumb bg-surface px-5 text-[15px] font-medium text-ink hover:border-ink disabled:opacity-60'
const TEXT_BUTTON =
  'p-0 text-[13.5px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-60'

/** What no app can do, whatever it is granted: the account and the console stay the member's. */
export const NEVER = ['delete', 'signIn', 'export', 'admin'] as const

export function ConnectPage() {
  const t = useTranslations('connect')
  const { status } = useSession()
  useTitle(t('title'))
  return (
    <>
      <header className="flex h-14 items-center justify-between gap-2.5 border-b border-line px-4 lg:px-7">
        {/* Not a link: leaving here leaves the app waiting, and the page says how to answer. */}
        <span className="flex items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink">
          <LogoMark />
          <span>Tela</span>
        </span>
        {status === 'member' ? (
          <MemberLanguage className="shrink-0" />
        ) : (
          <VisitorLanguage className="shrink-0" />
        )}
      </header>
      <main
        className="mx-auto flex w-full max-w-[540px] flex-1 animate-fade flex-col px-5 py-10 md:py-14"
        data-testid="connect"
      >
        {status === 'guest' ? <SignInFirst /> : null}
        {status === 'member' ? <Consent /> : null}
      </main>
    </>
  )
}

/** A visitor: the sheet opens at once, and again from here; signed in, they stay on this page. */
function SignInFirst() {
  const t = useTranslations('connect')
  const door = useFrontDoor()
  const opened = useRef(false)
  const open = useCallback(
    (mode: 'login' | 'join') => door?.(mode === 'login' ? { mode: 'login' } : { mode: 'join' }),
    [door],
  )
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    open('login')
  }, [open])
  return (
    <div className="flex flex-col gap-4" data-testid="connect-sign-in">
      <h1 className="m-0 font-serif text-[30px] leading-[1.15] font-medium tracking-[-0.015em]">
        {t('signIn.title')}
      </h1>
      <p className="m-0 text-[15px] text-ink-2">{t('signIn.body')}</p>
      <div className="mt-2 flex flex-wrap gap-2.5">
        <button
          type="button"
          className={PRIMARY}
          onClick={() => open('login')}
          data-testid="connect-log-in"
        >
          {t('signIn.logIn')}
        </button>
        <button
          type="button"
          className={QUIET}
          onClick={() => open('join')}
          data-testid="connect-join"
        >
          {t('signIn.join')}
        </button>
      </div>
    </div>
  )
}

type Shown =
  | { kind: 'loading' }
  | { kind: 'refused'; error: ConnectProblem }
  | { kind: 'asking'; request: ConnectRequest }
  /** The answer is on its way to the app: the browser is being sent there. */
  | { kind: 'sent'; approved: boolean; request: ConnectRequest }

function Consent() {
  const { search } = useLocation()
  const [shown, setShown] = useState<Shown>({ kind: 'loading' })
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again on Try again
  useEffect(() => {
    const controller = new AbortController()
    setShown({ kind: 'loading' })
    askConnect(search, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return
        setShown(
          answer.ok
            ? { kind: 'asking', request: answer.request }
            : { kind: 'refused', error: answer.error },
        )
      },
      () => {
        // Signed out or another account: api() has told the session. Offline: say so.
        if (!controller.signal.aborted) setShown({ kind: 'refused', error: 'failed' })
      },
    )
    return () => controller.abort()
  }, [search, retry])

  if (shown.kind === 'loading') return <p className="m-0 text-muted">…</p>
  if (shown.kind === 'refused') {
    return <Refused error={shown.error} onRetry={() => setRetry((n) => n + 1)} />
  }
  if (shown.kind === 'sent') return <Sent request={shown.request} approved={shown.approved} />
  return (
    <Asking
      request={shown.request}
      search={search}
      onRefused={(error) => setShown({ kind: 'refused', error })}
      onSent={(approved) => setShown({ kind: 'sent', approved, request: shown.request })}
    />
  )
}

/** Why the request cannot be answered here. Nothing is sent anywhere. */
export function Refused({ error, onRetry }: { error: ConnectProblem; onRetry: () => void }) {
  const t = useTranslations('connect')
  return (
    <div
      className="flex flex-col gap-4"
      role="alert"
      data-testid="connect-error"
      data-error={error}
    >
      <h1 className="m-0 font-serif text-[30px] leading-[1.15] font-medium tracking-[-0.015em]">
        {error === 'failed' ? t('errors.failedTitle') : t('errors.title')}
      </h1>
      <p className="m-0 text-[15px] text-ink-2">{t(`errors.${error}`)}</p>
      <p className="m-0 text-[14px] text-muted">{t('errors.nothingShared')}</p>
      <div className="mt-1 flex flex-wrap items-center gap-4">
        {error === 'failed' ? (
          <button type="button" className={QUIET} onClick={onRetry}>
            {t('errors.retry')}
          </button>
        ) : null}
        <Link to="/reading" className="text-[14px] text-ink underline">
          {t('errors.toReading')}
        </Link>
      </div>
    </div>
  )
}

/** Answered: the browser is on its way back to the app. */
export function Sent({ request, approved }: { request: ConnectRequest; approved: boolean }) {
  const t = useTranslations('connect')
  return (
    <div className="flex flex-col gap-3" data-testid="connect-sent">
      <h1 className="m-0 font-serif text-[30px] leading-[1.15] font-medium tracking-[-0.015em]">
        {approved
          ? t('sent.approved', { app: request.app.name })
          : t('sent.declined', { app: request.app.name })}
      </h1>
      <p className="m-0 text-[15px] text-ink-2">
        {request.redirect.kind === 'loopback' ? t('sent.loopback') : t('sent.scheme')}
      </p>
    </div>
  )
}

type AskingProps = {
  request: ConnectRequest
  search: string
  onRefused: (error: ConnectProblem) => void
  onSent: (approved: boolean) => void
}

/** The question, for the account this tab holds; switching signs out and comes back here. */
function Asking(props: AskingProps) {
  const { signOut } = useSession()
  const profile = useTables().profile
  const account = profile
    ? { handle: profile.handle, displayName: profile.displayName, avatar: profile.avatar }
    : null
  return (
    <ConsentForm
      {...props}
      account={account}
      onSwitch={() => void signOut(`${window.location.pathname}${window.location.search}`)}
    />
  )
}

/** Who is answering: the member's card, which the device's profile row holds. */
export type ConsentAccount = { handle: string; displayName: string | null; avatar: string | null }

export function ConsentForm({
  request,
  search,
  onRefused,
  onSent,
  account,
  onSwitch,
}: AskingProps & {
  /** Null until the device's first sync says whose account this is. */
  account: ConsentAccount | null
  onSwitch: () => void
}) {
  const t = useTranslations('connect')
  const { app } = request
  const [scope, setScope] = useState<AppScope>(request.scope)
  const [email, setEmail] = useState(request.email)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const levelId = useId()

  const answer = async (decision: 'approve' | 'decline') => {
    setBusy(true)
    setFailed(false)
    try {
      const approve = decision === 'approve'
      const sent = await decideConnect({
        ...requestParams(search),
        decision,
        scope_granted: approve ? scope : 'read',
        email_granted: approve && request.email && email,
      })
      if (!sent.ok) {
        if (sent.error === 'failed') setFailed(true)
        else onRefused(sent.error)
        return
      }
      onSent(approve)
      window.location.assign(sent.redirect)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-7" data-testid="connect-consent">
      <header className="flex flex-col gap-2">
        {app.status === 'draft' ? (
          <p
            className="m-0 flex items-start gap-2 self-start rounded-xl border border-thumb px-3 py-1.5 text-[13px] text-ink-2"
            data-testid="connect-draft"
          >
            <span
              aria-hidden="true"
              className="mt-[6px] size-[7px] shrink-0 rounded-full bg-warn"
            />
            {t('draft')}
          </p>
        ) : null}
        <h1 className="m-0 font-serif text-[30px] leading-[1.15] font-medium tracking-[-0.015em] [overflow-wrap:anywhere]">
          {t('heading', { app: app.name })}
        </h1>
        <p className="m-0 text-[14px] [overflow-wrap:anywhere] text-muted">
          {app.homepageUrl
            ? t.rich('byWithHome', {
                developer: app.developer,
                home: (chunks) => (
                  <a
                    href={app.homepageUrl ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink underline"
                  >
                    {chunks}
                  </a>
                ),
              })
            : t('by', { developer: app.developer })}
        </p>
      </header>

      {account ? (
        <section
          className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
          aria-label={t('account.label')}
          data-testid="connect-account"
        >
          <PersonAvatar
            handle={account.handle}
            displayName={account.displayName}
            avatar={account.avatar}
            size={36}
            me
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-muted">{t('account.as')}</div>
            <div className="truncate font-medium text-ink">
              {account.displayName ? `${account.displayName} · ` : ''}@{account.handle}
            </div>
          </div>
          <button
            type="button"
            className={TEXT_BUTTON}
            disabled={busy}
            onClick={onSwitch}
            data-testid="connect-switch"
          >
            {t('account.switch')}
          </button>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2
          id={levelId}
          className="m-0 text-[13px] font-semibold tracking-[.06em] text-muted uppercase"
        >
          {t('level.label')}
        </h2>
        {request.scope === 'write' ? (
          <div role="radiogroup" aria-labelledby={levelId} className="flex flex-col gap-2">
            {(['write', 'read'] as const).map((level) => (
              <label
                key={level}
                className={`flex cursor-pointer gap-3 rounded-xl border px-4 py-3 ${scope === level ? 'border-ink' : 'border-line'}`}
              >
                <input
                  type="radio"
                  name="level"
                  className="mt-1 shrink-0"
                  checked={scope === level}
                  onChange={() => setScope(level)}
                  data-testid={`connect-level-${level}`}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-ink">{t(`level.${level}`)}</span>
                  <span className="text-[13.5px] text-ink-2">{t(`level.${level}Body`)}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-line px-4 py-3" data-testid="connect-level-read">
            <div className="font-medium text-ink">{t('level.read')}</div>
            <div className="text-[13.5px] text-ink-2">{t('level.readBody')}</div>
          </div>
        )}
        {request.email ? (
          <label className="flex cursor-pointer items-start gap-3 px-1 text-[14px] text-ink">
            <input
              type="checkbox"
              className="mt-[3px] shrink-0"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
              data-testid="connect-email"
            />
            {t('email')}
          </label>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[13px] font-semibold tracking-[.06em] text-muted uppercase">
          {t('never.label')}
        </h2>
        <ul
          className="m-0 flex list-disc flex-col gap-1 pl-5 text-[14px] text-ink-2"
          data-testid="connect-never"
        >
          {NEVER.map((item) => (
            <li key={item}>{t(`never.${item}`)}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 text-[13.5px] text-muted">
        <p className="m-0" data-testid="connect-return">
          {request.redirect.kind === 'loopback'
            ? t('returns.loopback', { target: request.redirect.target })
            : t('returns.scheme', { target: request.redirect.target })}
        </p>
        <p className="m-0">
          {app.privacyUrl
            ? t.rich('responsibility', {
                app: app.name,
                policy: (chunks) => (
                  <a
                    href={app.privacyUrl ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink underline"
                  >
                    {chunks}
                  </a>
                ),
              })
            : t('responsibilityNoPolicy', { app: app.name })}
        </p>
        <p className="m-0">
          {t.rich('later', {
            // Apart from this page, which holds the request the app is waiting on.
            link: (chunks) => (
              <a href="/privacy#apps" target="_blank" rel="noopener" className="text-ink underline">
                {chunks}
              </a>
            ),
          })}
        </p>
      </section>

      {failed ? (
        <p role="alert" className="m-0 text-[14px] text-danger" data-testid="connect-failed">
          {t('errors.decideFailed')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2.5">
        <button
          type="button"
          className={PRIMARY}
          // Not before the page can say which account it connects.
          disabled={busy || !account}
          onClick={() => void answer('approve')}
          data-testid="connect-approve"
        >
          {t('approve')}
        </button>
        <button
          type="button"
          className={QUIET}
          disabled={busy}
          onClick={() => void answer('decline')}
          data-testid="connect-decline"
        >
          {t('decline')}
        </button>
      </div>
    </div>
  )
}
