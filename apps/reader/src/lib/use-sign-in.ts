/**
 * Signing in and joining, wherever the form is (the sheet, `/login`): ADRs 0024, 0034 and 0036.
 * Four ways in, behind one gate on tela-api:
 *
 * - **An emailed code**, which is also how an account starts. Joining first holds an invite code
 *   beside the address (`/api/v1/join`), and the code's sign-in claims it.
 * - **A password**, chosen when joining, at the code step or from the mail's link, or set by a
 *   reset code: never before a code has proved the address. Log in opens on it (ADR 0043).
 * - **Google or GitHub**, started here and finished by tela-api's callback, which sends a refusal
 *   back to the page with `?error=`.
 * - **The mail's link**, which fills the code in and waits for a press. A link that signed in by
 *   itself would put whoever opened it into the account of whoever sent it, a login CSRF.
 *
 * Nothing here can say whether an address has an account: a code, a reset and a wrong password
 * are answered the same for a member and for a stranger (though not in the same time: ADR 0036).
 */
import { normalizeInviteCode } from '@tela/shared'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useSession } from '../session'
import { api } from '../store/api'
import { type CardClaim, finishCard, keepClaim, takeClaim } from './claim-card'

/** A password's length, as tela-api's better-auth checks it (ADR 0036). */
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 128

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Where a new member goes first: something to subscribe to. */
export const NEWCOMER = '/discover'

/** Any origin will do for resolving a path against: only whether it stays the same is asked. */
const HERE = 'https://tela.invalid'

/**
 * Only a path on this site, as the browser will read it. A browser drops tabs and newlines from a
 * URL and reads `\` as `/`, so `/\t/evil.example` and `/\evil.example` are `//evil.example`, another
 * site: a value with any control character or backslash is refused outright, and what is left must
 * resolve to this origin.
 */
export function safeNext(next: string | null, fallback = '/reading'): string {
  if (!next?.startsWith('/') || /[\\\p{Cc}]/u.test(next)) return fallback
  try {
    const url = new URL(next, HERE)
    return url.origin === HERE ? `${url.pathname}${url.search}${url.hash}` : fallback
  } catch {
    return fallback
  }
}

/**
 * Where the sheet sends whoever it lets in. One it signs in goes to `next`: the blog a card claims,
 * a log-in's own `next`, or for a joiner Discover. One it finds already a member (`/me` answering
 * while it is open) was not signed in by it, and goes where a member goes: a log-in's `next` still,
 * but a join has nothing to make, so its reading rather than a newcomer's Discover.
 */
export function doorRoutes(
  mode: DoorMode,
  asked: string | null,
  claim: string | null,
): { next: string; newcomer: string; settledNext: string } {
  const next = claim ?? (mode === 'login' ? safeNext(asked) : NEWCOMER)
  return {
    next,
    newcomer: claim ?? NEWCOMER,
    settledNext: mode === 'join' && !claim ? safeNext(null) : next,
  }
}

/**
 * What a mailed link carries: a sign-in code, or with `reset=1` a password reset's code. A first
 * sign-in's code says `join=1`, and its link asks for the password the joiner chooses (ADR 0043).
 */
export type MailLink = { email: string; otp: string; reset: boolean; join: boolean }

export function mailLink(search: URLSearchParams): MailLink | null {
  const email = search.get('email')
  const otp = search.get('otp')
  if (!email || !otp) return null
  const reset = search.get('reset') === '1'
  return { email, otp, reset, join: !reset && search.get('join') === '1' }
}

/** The address bar once a link's code or an error is out of it: only where to go next stays. */
export function loginPath(search: URLSearchParams): string {
  const next = search.get('next')
  return next ? `/login?next=${encodeURIComponent(safeNext(next))}` : '/login'
}

export const PROVIDERS = ['google', 'github'] as const
export type Provider = (typeof PROVIDERS)[number]

/** Log in to an account, or make one with an invitation. */
export type DoorMode = 'login' | 'join'

/** What the form can say went wrong; each is a `door.errors.*` string. */
export type SignInError =
  | 'invalid_email'
  | 'send_failed'
  | 'bad_code'
  | 'rate_limited'
  | 'reset_failed'
  | 'password_set'
  | 'password_short'
  | 'bad_password'
  | 'not_invited'
  | 'invite_used'
  | 'missing_code'
  | 'invalid_code'
  | 'code_used'
  | 'provider_unlinked'
  | 'provider_no_email'
  | 'provider_cancelled'
  | 'provider_expired'
  | 'provider_failed'
  | 'failed'

/** The gate's refusals (ADR 0034), as an email-code sign-in or a provider names them. */
function inviteRefusal(code: unknown): SignInError | null {
  if (typeof code !== 'string') return null
  const known = code.toLowerCase()
  if (known === 'invite_required') return 'not_invited'
  if (known === 'invite_used' || known === 'invite_unavailable') return 'invite_used'
  return null
}

/**
 * A refused code: too many tries, the gate's refusal (the address holds no invitation, or the
 * one it held is full), or else the code itself. Saying "wrong code" for either of the first two
 * would send the visitor hunting for a typo.
 */
export function codeError(status: number, code: unknown): SignInError {
  if (status === 429) return 'rate_limited'
  return inviteRefusal(code) ?? 'bad_code'
}

/** What `/api/v1/join` answered: 400 `invalid_code` or `invalid_email`, 409 `code_used`, 429. */
export function joinError(status: number, error: unknown): SignInError {
  if (status === 429) return 'rate_limited'
  if (error === 'invalid_code') return 'invalid_code'
  if (error === 'invalid_email') return 'invalid_email'
  if (status === 409 || error === 'code_used') return 'code_used'
  return 'send_failed'
}

/**
 * A Google or GitHub sign-in's `?error=`, named by the gate, by better-auth or by the provider
 * itself. Any code not listed is the provider's failure in general: the list is better-auth's,
 * and a new one must still say something.
 */
export function providerError(code: string): SignInError {
  const refused = inviteRefusal(code)
  if (refused) return refused
  switch (code.toLowerCase()) {
    case 'email_not_verified':
    case 'account_not_linked':
      return 'provider_unlinked'
    case 'email_not_found':
      return 'provider_no_email'
    case 'access_denied':
      return 'provider_cancelled'
    case 'state_mismatch':
    case 'state_not_found':
    case 'state_security_mismatch':
    case 'please_restart_the_process':
      return 'provider_expired'
    case 'too_many_requests':
      return 'rate_limited'
    default:
      return 'provider_failed'
  }
}

/**
 * Why a Google or GitHub sign-in would not start (tela-api's `startWithProvider`): the invite code
 * it carried, checked before the visitor leaves (400 `INVALID_CODE`, 409 `INVITE_USED`, as a join
 * by email answers), a limit, or the provider in general. Not `providerError`, which reads the
 * return: there better-auth's `invalid_code` is a failed token exchange, not an invite.
 */
export function startError(status: number, code: unknown): SignInError {
  if (status === 429) return 'rate_limited'
  if (code === 'INVALID_CODE') return 'invalid_code'
  if (code === 'INVITE_USED') return 'code_used'
  return providerError(typeof code === 'string' ? code : '')
}

/** What a page's query says about the door, and is taken out of the address bar once read. */
const DOOR_PARAMS = ['door', 'via', 'error', 'error_description'] as const

/**
 * Where tela-api sends a refused Google or GitHub sign-in: the page it started on, which opens the
 * sheet again in `mode` and says why. Root-relative, since better-auth checks it against the
 * trusted origins.
 */
export function errorReturn(
  pathname: string,
  search: string,
  mode: DoorMode,
  provider: Provider,
): string {
  const params = new URLSearchParams(search)
  for (const name of DOOR_PARAMS) params.delete(name)
  params.set('door', mode)
  params.set('via', provider)
  return `${pathname}?${params}`
}

/** A page's query without what the door put in it, for `history.replaceState`. */
export function withoutDoor(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  for (const name of DOOR_PARAMS) params.delete(name)
  const rest = params.toString()
  return rest ? `${pathname}?${rest}` : pathname
}

/**
 * The invite code a Google or GitHub join carried, kept for this tab while the provider has the
 * page, so a refusal comes back with it filled in. tela-api has its own copy in the OAuth state.
 */
const INVITE_KEY = 'tela.invite'

function keepInvite(code: string): void {
  try {
    sessionStorage.setItem(INVITE_KEY, code)
  } catch {
    // No sessionStorage: a refusal comes back without the code, which is typed again.
  }
}

export function takeInvite(): string | null {
  try {
    const code = sessionStorage.getItem(INVITE_KEY)
    sessionStorage.removeItem(INVITE_KEY)
    return code
  } catch {
    return null
  }
}

/**
 * Where the form is. `start`: the address (with a password, or an invite code to join). `code`:
 * the emailed code, and when joining the password they choose. `reset`: a reset code and the new
 * password. `link`: a mailed link waiting for a press, and for a join's the password. `unsaved`:
 * signed in, but the password chosen when joining was not saved.
 */
export type SignInStep =
  | { kind: 'start' }
  | { kind: 'code'; email: string; joining: boolean }
  | { kind: 'reset'; email: string }
  | { kind: 'link'; link: MailLink }
  | { kind: 'unsaved' }

export type SignInOptions = {
  /** Where to go once signed in. */
  next: string
  /**
   * Where a member the form did not sign in goes, found at the start (`settled`): `next` unless
   * said otherwise.
   */
  settledNext?: string | undefined
  /** Where an account made by Google or GitHub goes first. */
  newcomer: string
  /** Where tela-api sends a refused Google or GitHub sign-in back to. */
  errorReturn: (provider: Provider) => string
  /** A mailed link to answer first. */
  link?: MailLink | null | undefined
  /** What a page arrived saying (a provider's refusal). */
  error?: SignInError | null | undefined
  /** Leave by replacing this page's history entry rather than adding one. */
  replace?: boolean | undefined
  /** Signed in, and about to leave for `next`: the sheet closes. */
  onDone?: (() => void) | undefined
  /**
   * For writers' card, made once signed in (`lib/claim-card.ts`): the handle and name while the
   * member's are provisional, then on to claim the blog, wherever `next` said.
   */
  claim?: CardClaim | undefined
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })

/** An answer's JSON fields, or none: better-auth's errors are `{code, message}`, Tela's `{error}`. */
async function fields(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

const clean = (email: string) => email.trim().toLowerCase()

/**
 * Set the new member's password: a member call, so it names them (AGENTS invariant 8), by the id
 * the code's sign-in answered with, since the tab does not hold their account yet. tela-api takes
 * a first password on the fresh session the code just made (`POST /api/v1/account/password
 * {newPassword}`); any refusal leaves the member signed in without one.
 */
export async function savePassword(newPassword: string, member: string): Promise<boolean> {
  try {
    const res = await api('/api/v1/account/password', { body: { newPassword }, member })
    return res.ok
  } catch {
    return false
  }
}

/** Whom a code's sign-in signed in: better-auth answers `{token, user}`. */
function signedInAs(body: Record<string, unknown>): string | null {
  const { user } = body
  if (typeof user !== 'object' || user === null) return null
  const { id } = user as { id?: unknown }
  return typeof id === 'string' && id ? id : null
}

export function useSignIn(options: SignInOptions) {
  const { status, retrying, signedIn } = useSession()
  const navigate = useNavigate()
  // A link is read on the first render too, so a member's tab shows it rather than leave at once.
  const [step, setStep] = useState<SignInStep>(() =>
    options.link ? { kind: 'link', link: options.link } : { kind: 'start' },
  )
  const [error, setError] = useState<SignInError | null>(options.error ?? null)
  const [busy, setBusy] = useState(false)
  // Signed in, and waiting for /me to say as whom: the code is spent, so the form stays shut.
  const [waiting, setWaiting] = useState(false)
  const left = useRef(false)
  const latest = useRef(options)
  latest.current = options

  const leave = async (then?: string) => {
    if (left.current) return
    left.current = true
    const { claim } = latest.current
    // A card is this form's to finish while it is open; a copy kept for the app goes.
    if (claim) takeClaim()
    const to = claim ? await finishCard(claim) : (then ?? latest.current.next)
    latest.current.onDone?.()
    navigate(to, { replace: latest.current.replace ?? false })
  }

  const leaving = useRef(leave)
  leaving.current = leave

  /** Signed in: learn as whom, which may load a fresh page, and go on. */
  const enter = async () => {
    const outcome = await signedIn(latest.current.next)
    // The page may go before the session is known (a reload at `next`), or the sheet be closed
    // while it waits: the card is kept for the app to finish once it is the member's.
    const { claim } = latest.current
    if (claim && (outcome === 'waiting' || outcome === 'reloading')) keepClaim(claim)
    if (outcome === 'waiting') setWaiting(true)
    else if (outcome !== 'reloading') await leave()
  }

  // /me answered at last, on the session's own retry: carry on as the sign-in would have. Busy
  // meanwhile, so the form cannot start again and the sheet stays open under what is left.
  useEffect(() => {
    if (!waiting || status !== 'member') return
    setWaiting(false)
    setBusy(true)
    void leaving.current().finally(() => setBusy(false))
  }, [waiting, status])

  // A member has nothing to do at the start: they go on, where a member goes rather than where one
  // this form signs in would (a member shown a link stays to answer it, since it may be for
  // another account, which is how one switches).
  const settled = status === 'member' && !busy && !waiting && step.kind === 'start'
  // biome-ignore lint/correctness/useExhaustiveDependencies: `leave` reads the latest options through a ref
  useEffect(() => {
    if (settled) void leave(latest.current.settledNext)
  }, [settled])

  const run = async (work: () => Promise<void>, fallback: SignInError = 'failed') => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch {
      setError(fallback)
    } finally {
      setBusy(false)
    }
  }

  const sendCode = (input: string) =>
    run(async () => {
      const email = clean(input)
      if (!EMAIL.test(email)) return setError('invalid_email')
      const res = await post('/api/auth/email-otp/send-verification-otp', {
        email,
        type: 'sign-in',
      })
      if (!res.ok) return setError(res.status === 429 ? 'rate_limited' : 'send_failed')
      setStep({ kind: 'code', email, joining: false })
    }, 'send_failed')

  /** Hold the invite beside the address, which mails it a code (ADR 0034). */
  const join = (invite: string, input: string) =>
    run(async () => {
      const code = normalizeInviteCode(invite)
      if (!code) return setError(invite.trim() ? 'invalid_code' : 'missing_code')
      const email = clean(input)
      if (!EMAIL.test(email)) return setError('invalid_email')
      const res = await post('/api/v1/join', { code, email })
      if (!res.ok) return setError(joinError(res.status, (await fields(res)).error))
      setStep({ kind: 'code', email, joining: true })
    }, 'send_failed')

  const verify = (email: string, otp: string, password = '') =>
    run(async () => {
      // Joining chooses a password, whether the code is typed or comes in the mail's link (ADR
      // 0043); any other sign-in by code sets none.
      const joining =
        (step.kind === 'code' && step.joining) || (step.kind === 'link' && step.link.join)
      if ((joining || password) && password.length < PASSWORD_MIN) {
        return setError('password_short')
      }
      const res = await post('/api/auth/sign-in/email-otp', { email, otp: otp.trim() })
      if (!res.ok) {
        const why = codeError(res.status, (await fields(res)).code)
        // The gate's refusal has spent the code: only a fresh start can go on.
        const refused = why === 'not_invited' || why === 'invite_used'
        setStep(refused ? { kind: 'start' } : { kind: 'code', email, joining })
        return setError(why)
      }
      // The password a joiner chose is saved before the tab learns who signed in: a tab that held
      // another account loads a fresh page then, and nothing typed into this one outlives it. A
      // save that fails says so first, and Continue goes on from there.
      if (password) {
        const member = signedInAs(await fields(res))
        if (!member || !(await savePassword(password, member))) {
          return setStep({ kind: 'unsaved' })
        }
      }
      await enter()
    })

  const logIn = (input: string, password: string) =>
    run(async () => {
      const email = clean(input)
      if (!EMAIL.test(email)) return setError('invalid_email')
      const res = await post('/api/auth/sign-in/email', { email, password })
      // One answer for an unknown address, an account without a password and a wrong one.
      if (!res.ok) {
        return setError(
          res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'failed' : 'bad_password',
        )
      }
      await enter()
    })

  /** Ask for a reset code: mailed only to an account, answered the same for any address. */
  const forgot = (input: string) =>
    run(async () => {
      const email = clean(input)
      if (!EMAIL.test(email)) return setError('invalid_email')
      const res = await post('/api/auth/email-otp/request-password-reset', { email })
      if (!res.ok) return setError(res.status === 429 ? 'rate_limited' : 'send_failed')
      setStep({ kind: 'reset', email })
    }, 'send_failed')

  /** A reset code sets the new password; then that password signs in. */
  const reset = (email: string, otp: string, password: string) =>
    run(async () => {
      if (password.length < PASSWORD_MIN) return setError('password_short')
      const done = await post('/api/auth/email-otp/reset-password', {
        email,
        otp: otp.trim(),
        password,
      })
      if (!done.ok) return setError(done.status === 429 ? 'rate_limited' : 'reset_failed')
      const res = await post('/api/auth/sign-in/email', { email, password })
      if (!res.ok) {
        // The code is spent and the password set: what is left is signing in, by code for now.
        setStep({ kind: 'start' })
        return setError('password_set')
      }
      await enter()
    })

  /**
   * Answer a mailed link: its code signs in, a join's with the password chosen beside it, or with
   * a reset link sets `password` first.
   */
  const confirmLink = (password: string) => {
    if (step.kind !== 'link') return Promise.resolve()
    const { email, otp, reset: resetting, join } = step.link
    if (resetting) return reset(email, otp, password)
    return join ? verify(email, otp, password) : verify(email, otp)
  }

  /**
   * Off to Google or GitHub (ADR 0036). tela-api answers with the provider's address rather than
   * a redirect, so the start is an ordinary same-origin POST the edge lets through. A join's invite
   * code rides in the OAuth state, which only tela-api writes.
   */
  const provider = async (which: Provider, invite = '') => {
    setBusy(true)
    setError(null)
    const code = invite.trim() ? normalizeInviteCode(invite) : null
    if (invite.trim() && !code) {
      setError('invalid_code')
      setBusy(false)
      return
    }
    const { next, newcomer } = latest.current
    try {
      const res = await post('/api/auth/sign-in/social', {
        provider: which,
        callbackURL: next,
        newUserCallbackURL: newcomer,
        errorCallbackURL: latest.current.errorReturn(which),
        disableRedirect: true,
        ...(code ? { additionalData: { invite: code } } : {}),
      })
      const body = await fields(res)
      const url = typeof body.url === 'string' ? body.url : ''
      if (!res.ok || !url.startsWith('https://')) {
        setError(startError(res.status, body.code))
        setBusy(false)
        return
      }
      if (code) keepInvite(code)
      if (latest.current.claim) keepClaim(latest.current.claim)
      // Busy until the page is gone: a second press would start a second flow.
      window.location.assign(url)
    } catch {
      setError('provider_failed')
      setBusy(false)
    }
  }

  /** Back to the start, with nothing said. */
  const restart = () => {
    setStep({ kind: 'start' })
    setError(null)
  }

  return {
    step,
    error,
    busy,
    /** Signed in, and /me cannot be reached yet: the form says so and stays shut. */
    connecting: waiting && retrying,
    /**
     * Carrying a sign-in through: a request out, /me awaited, or an unsaved password being told.
     * Until the form lets go, it says where a member goes, not the page it is over.
     */
    carrying: busy || waiting || step.kind === 'unsaved',
    /** A member at the start, leaving for `settledNext`: nothing to show. */
    settled,
    sendCode,
    join,
    verify,
    logIn,
    forgot,
    reset,
    confirmLink,
    provider,
    restart,
    /** Past an unsaved password: go on in as the member, to `next`, anyway. */
    goOn: () => void run(enter),
  }
}
