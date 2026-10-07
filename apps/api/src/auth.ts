/**
 * Sign-in (ADR 0024): better-auth with email codes, passwords, Google and GitHub, through its
 * Drizzle adapter over the same `TelaDb` everything else uses, so it runs on D1 in production and
 * libSQL in tests. An account is made at an address's first code sign-in, at a provider's return,
 * or by the operator's invite, and only for an address that holds an invitation (ADR 0034):
 * `user.create.before` is the gate, and the code mail is sent to nobody else. A provider's return
 * is admitted only by the invite code its sign-in carried. A password is never how an account
 * starts: it is set on a member a code has proved, and a forgotten one is reset by code (ADR 0036).
 */
import {
  ACTION_LIMITS,
  bumpSeq,
  claimByCode,
  claimInvite,
  consumeLimit,
  currentSeq,
  first,
  holdsInvite,
  type LimitedAction,
  liveCode,
  schema,
  settleInvite,
  type TelaDb,
  waitsOnFullCode,
} from '@tela/data'
import { DEFAULT_UI_LOCALE, normalizeInviteCode } from '@tela/shared'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getIP,
  getOAuthState,
} from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import type { ApiConfig, ApiDeps } from './deps'
import {
  type AccountChange,
  accountChangeMail,
  passwordResetMail,
  providerAccountMail,
  signInMail,
} from './mail'
import { accountLocale, mailLocale } from './mail-locale'

/** Cookie names start `tela.`; tela-web reads `tela.session_data` to authorize /o and /img. */
export const COOKIE_PREFIX = 'tela'
/** How long a signed session cache is trusted before the session is read from D1 again. */
export const COOKIE_CACHE_SECONDS = 5 * 60
const CODE_SECONDS = 60 * 60
const DAY = 24 * 60 * 60
/**
 * How recent a sign-in must be for what needs one (ADR 0036): adding a way in, or taking one away.
 * better-auth's default too, said here because the account routes rest on it.
 */
export const FRESH_SECONDS = DAY
/** How long a password may be (ADR 0036): checked by better-auth, and by Tela before counting. */
export const PASSWORD_LENGTH = { min: 10, max: 128 } as const

/**
 * Every endpoint that mails a code to an address or checks one against it, and the password
 * sign-in, counted per email address as well as per IP (ADR 0036): better-auth's limiter keys on
 * the IP and the path alone. All kinds of code share the two counts, so an address is mailed five
 * codes and has ten guesses checked an hour, whatever the codes are for. The reset steps count
 * like sign-in: a right reset code gives the account a password. The plugin's change-email pair
 * needs a session and is off; `auth.test.ts` fails on any other. The endpoints `/api/auth` does
 * not serve (`AUTH_ENDPOINTS` in `app.ts`) are counted all the same, so serving one later cannot
 * open it uncounted. Passwords have a count of their own, so guessing one never locks the member
 * out of their code.
 */
export const PER_ADDRESS = new Map<string, LimitedAction>([
  ['/email-otp/send-verification-otp', 'otpSend'],
  ['/email-otp/request-password-reset', 'otpSend'],
  ['/forget-password/email-otp', 'otpSend'],
  ['/sign-in/email-otp', 'otpVerify'],
  ['/email-otp/check-verification-otp', 'otpVerify'],
  ['/email-otp/verify-email', 'otpVerify'],
  ['/email-otp/reset-password', 'otpVerify'],
  ['/sign-in/email', 'passwordSignIn'],
])
/** No deliverable address is longer (RFC 5321), and the key is written before anything checks it. */
const ADDRESS_MAX = 254
/** What better-auth's own limiter answers, so a 429 does not say which limit it was. */
const TOO_MANY = 'Too many requests. Please try again later.'
const tooMany = (retryAfterSec: number) =>
  new APIError(
    'TOO_MANY_REQUESTS',
    { message: TOO_MANY },
    { 'X-Retry-After': String(retryAfterSec) },
  )

/** The endpoints that may make an account: the code sign-in, and a provider's return. */
const CODE_SIGN_IN = '/sign-in/email-otp'
const PROVIDER_RETURN = '/callback/:id'
/** Where a provider's sign-in starts, and all it may be sent (ADR 0036). */
const PROVIDER_START = '/sign-in/social'
const PROVIDER_START_FIELDS = new Set([
  'provider',
  'callbackURL',
  'newUserCallbackURL',
  'errorCallbackURL',
  'disableRedirect',
  'additionalData',
])
/** better-auth's bucket for a request whose IP it cannot tell, which all such requests share. */
const NO_IP = 'no-trusted-ip'

/** A fresh handle for a new member, changed later in settings: `u_` and ten hex digits. */
export function provisionalHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return `u_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * A member's profile, with a provisional handle. Idempotent per member: written when the account is
 * made and again by a sign-in that finds none. Only a second profile for the member is ignored; a
 * handle that clashes still fails, rather than leave the member with none.
 */
async function createProfile(db: TelaDb, userId: string, now: number) {
  await db.batch([
    bumpSeq(db),
    db
      .insert(schema.profiles)
      .values({
        userId,
        handle: provisionalHandle(),
        createdAt: now,
        updatedAt: now,
        seq: currentSeq,
      })
      .onConflictDoNothing({ target: schema.profiles.userId }),
  ])
}

/**
 * Why the gate turns an address away, in the `code` of its 403, and why a provider's sign-in will
 * not start with the code it carried (400 `INVALID_CODE`, 409 `INVITE_USED`, as `/api/v1/join`
 * answers).
 */
const REFUSALS = {
  /** Nothing the address holds admits it, or it came a way that makes no account. */
  INVITE_REQUIRED: 'An account is made only for an address that holds an invitation.',
  /** Its hold is on a code that others filled since its code was mailed. */
  INVITE_USED: 'Everyone this invite code was for has joined.',
  /** A provider's sign-in carried a code that is unknown or revoked: one answer for both. */
  INVALID_CODE: 'No such invite code, or it was withdrawn.',
} as const

const refuse = (code: keyof typeof REFUSALS) =>
  new APIError('FORBIDDEN', { code, message: REFUSALS[code] })

/**
 * Why a provider's return makes no account, as the `error` of its redirect to the page that
 * started it: lowercase, like better-auth's own codes there. `invite_required`: the sign-in carried
 * no invite code. `invite_unavailable`: its code was filled or revoked while the visitor was at the
 * provider. `account_not_linked`: the provider has not verified the address, which is also what
 * better-auth answers a member whose provider is not linked, so the redirect says nothing of who
 * is a member; for that reason none carries a description, as better-auth's does not. The sheet
 * words each.
 */
type ReturnRefusal = 'invite_required' | 'invite_unavailable' | 'account_not_linked'
const refuseReturn = (code: ReturnRefusal) => new APIError('FORBIDDEN', { code })

/**
 * What a provider's sign-in may start with (ADR 0036): only the provider, the three return URLs
 * (better-auth checks they are Tela's), `disableRedirect`, and an invite code in
 * `additionalData.invite`. Anything else is refused rather than passed on: `scopes`,
 * `additionalParams` and `loginHint` would widen what the provider is asked for, and `idToken`
 * signs in with no state at all. An invite is checked here, before the visitor is sent away, and
 * handed to the callback in the OAuth state's server context, which only the server writes and
 * the callback alone reads. A check is a guess at a code like a join's, so it spends a join's
 * limits: per IP before the code is looked up, then per code for a live one.
 */
async function startWithProvider(
  db: TelaDb,
  body: Record<string, unknown>,
  ip: string | null,
  now: number,
): Promise<void> {
  const extra = body.additionalData
  const unexpected = Object.keys(body).filter((key) => !PROVIDER_START_FIELDS.has(key))
  if (extra !== undefined) {
    if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
      unexpected.push('additionalData')
    } else {
      for (const key of Object.keys(extra))
        if (key !== 'invite') unexpected.push(`additionalData.${key}`)
    }
  }
  const invite = (extra as { invite?: unknown } | undefined)?.invite
  if (invite !== undefined && typeof invite !== 'string') unexpected.push('additionalData.invite')
  if (unexpected.length > 0) {
    throw new APIError('BAD_REQUEST', {
      code: 'VALIDATION_ERROR',
      message: `Not accepted: ${unexpected.join(', ')}`,
    })
  }
  if (invite === undefined) return
  const code = normalizeInviteCode(invite)
  const invalid = () =>
    new APIError('BAD_REQUEST', { code: 'INVALID_CODE', message: REFUSALS.INVALID_CODE })
  if (!code) throw invalid()
  if (ip !== null) {
    const { allowed, retryAfterSec } = await consumeLimit(db, 'joinIp', ip, now)
    if (!allowed) throw tooMany(retryAfterSec)
  }
  const live = await liveCode(db, code)
  if (!live) throw invalid()
  if (ip !== null) {
    const limit = Math.max(ACTION_LIMITS.joinCode.limit, live.places)
    const { allowed, retryAfterSec } = await consumeLimit(db, 'joinCode', code, now, limit)
    if (!allowed) throw tooMany(retryAfterSec)
  }
  if (live.full)
    throw new APIError('CONFLICT', { code: 'INVITE_USED', message: REFUSALS.INVITE_USED })
  await addOAuthServerContext({ invite: code })
}

/**
 * Google and GitHub (ADR 0036), each only while its app is configured, asking for no more than an
 * address: Tela keeps neither the name nor the picture. No ID-token sign-in, which has no state,
 * and Google asks which account rather than taking whichever is signed in.
 */
function socialProviders(oauth: ApiConfig['oauth']) {
  return {
    ...(oauth?.google
      ? {
          google: {
            ...oauth.google,
            disableDefaultScope: true,
            scope: ['openid', 'email'],
            prompt: 'select_account' as const,
            disableIdTokenSignIn: true,
          },
        }
      : {}),
    ...(oauth?.github
      ? {
          github: {
            ...oauth.github,
            disableDefaultScope: true,
            scope: ['user:email'],
            disableIdTokenSignIn: true,
          },
        }
      : {}),
  }
}

/** Every token a provider hands back, which Tela never uses and so never keeps. */
const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
}

/**
 * End every session a member has but the one whose token is kept (none when `keep` is null), and
 * say how many ended (ADR 0036). Each device's signed five-minute copy of an ended session still
 * works where only that copy is read (ADR 0024); `/api/v1/account` reads past it.
 */
export async function endOtherSessions(
  db: TelaDb,
  userId: string,
  keep: string | null,
): Promise<number> {
  const ended = await db
    .delete(schema.session)
    .where(and(eq(schema.session.userId, userId), ne(schema.session.token, keep ?? '')))
    .returning({ id: schema.session.id })
  return ended.length
}

/**
 * Whether `token` is one of the member's sessions and has not ended, read from D1 rather than any
 * signed copy. better-auth stamps a session's expiry with the wall clock, not tela-api's.
 */
async function isLiveSession(db: TelaDb, userId: string, token: string): Promise<boolean> {
  const found = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.token, token),
        eq(schema.session.userId, userId),
        gt(schema.session.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return found.length > 0
}

/**
 * What a sign-in finds missing from what making the account should have written, written now: a
 * profile, when the insert that follows the user's failed, and the settlement of the invitation
 * that admitted them. One read when nothing is.
 */
async function repairMember(db: TelaDb, userId: string, now: number) {
  const found = await first<{ email: string; profiled: number; unsettled: number }>(
    db,
    sql`select u.email,
      exists (select 1 from profiles p where p.user_id = u.id) as profiled,
      exists (select 1 from invite_redemptions r where r.email = u.email
        and r.redeemed_at is not null and r.settled_at is null) as unsettled
    from user u where u.id = ${userId}`,
  )
  if (!found) return
  if (!found.profiled) await createProfile(db, userId, now)
  if (found.unsettled) await settleInvite(db, { email: found.email, userId, now })
}

/**
 * Tell a member about a change to their ways in (ADR 0036), in their interface language beside
 * English. A notice that fails to go is logged rather than fail the change, which is made by then;
 * a language that cannot be read is English, since the notice matters more than its language.
 */
export async function notifyMember(
  deps: Pick<ApiDeps, 'db' | 'mail' | 'config'>,
  member: { id: string; email: string },
  change: AccountChange,
): Promise<void> {
  const locale = await accountLocale(deps.db, member.id).catch(() => DEFAULT_UI_LOCALE)
  await deps.mail
    .send(accountChangeMail({ to: member.email, change, publicUrl: deps.config.publicUrl, locale }))
    .catch((err) => console.error('account notice not sent', member.id, err))
}

export function createAuth(deps: Pick<ApiDeps, 'db' | 'mail' | 'clock' | 'config'>) {
  const { db, mail, clock, config } = deps
  return betterAuth({
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(db, { provider: 'sqlite', schema: schema.authTables }),
    // An error before a flow's own return URL is known lands on the sign-in page, not on
    // better-auth's error page, which `/api/auth` does not serve.
    onAPIError: { errorURL: `${config.publicUrl}/login` },
    socialProviders: socialProviders(config.oauth),
    /**
     * Linking is explicit only (ADR 0036): a member adds a provider from Settings. A provider's
     * verification says the address was proved once, not who holds it now, so a provider whose
     * address matches a member's is answered `account_not_linked` rather than let in; and no
     * provider is trusted, since a trusted one links without a verified address at all. An
     * explicit link may use another address, and a member may unlink everything: the code is
     * always a way back in. Nothing a provider returns is kept but the identity: tokens are
     * dropped as every account row is written, and never refreshed at a sign-in.
     */
    account: {
      storeStateStrategy: 'database',
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
      },
    },
    session: {
      expiresIn: 60 * DAY,
      updateAge: DAY,
      // A signed copy of the session in a cookie: tela-api reads no session row for 5 minutes,
      // and tela-web authorizes content objects without D1 at all.
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS, strategy: 'compact' },
      freshAge: FRESH_SECONDS,
    },
    /**
     * Passwords (ADR 0036), for members only: a password is set on a member whose address a code
     * proved, or by a reset code, never at sign-up. Signing up with one would make the account,
     * and spend its invitation, before the address was proved, and leave a stranger's password on
     * the row for the address's owner to inherit; `disableSignUp` closes `/sign-up/email`, which
     * `/api/auth` does not serve either. Both ways to a password verify the address, so
     * `requireEmailVerification` never fires; it is there should that ever stop being true. A
     * reset ends every session, as someone else may hold one.
     */
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      revokeSessionsOnPasswordReset: true,
      // The member is told, as at every change to their ways in. A notice that fails to go is
      // logged rather than fail the reset, which has set the password by then.
      onPasswordReset: ({ user }) => notifyMember(deps, user, { kind: 'password-reset' }),
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Behind Cloudflare every request arrives from Cloudflare; without this every visitor
      // shares one rate-limit bucket (spike S4).
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The cookie that ties a provider's return to the browser that left, as long as the state
      // row it names (ten minutes): at better-auth's five, a provider's own sign-up or 2FA can
      // outlast it.
      cookies: { state: { attributes: { maxAge: 600 } } },
      // The origin and return-URL checks. better-auth turns them off when it thinks it runs under
      // test; said here so the suite runs them as production does.
      disableOriginCheck: false,
    },
    // Per-isolate memory is useless on Workers: limits live in D1. A password try costs a hash,
    // known address or not, so the password sign-in gets five a minute per IP rather than
    // better-auth's three every ten seconds.
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    hooks: {
      // A provider's sign-in is checked before it starts (`startWithProvider`). Everything that
      // mails or checks a code, or tries a password, is counted for any address, member or not,
      // keyed as better-auth keys the code (the lowercased address), and refused the same way for
      // all of them, so a 429 says nothing about who has an account. Only requests from outside
      // are counted. tela-api's own calls through `auth.api` carry no request: the operator's
      // invite needs no limit, and a route that lets anyone trigger one must count for itself.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === PROVIDER_START) {
          const ip = ctx.request ? (getIP(ctx.request, ctx.context.options) ?? NO_IP) : null
          const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}
          return startWithProvider(db, body, ip, clock.now())
        }
        const action = PER_ADDRESS.get(ctx.path)
        const email: unknown = ctx.body?.email
        if (!action || !ctx.request || typeof email !== 'string') return
        const address = email.toLowerCase().slice(0, ADDRESS_MAX)
        const { allowed, retryAfterSec } = await consumeLimit(db, action, address, clock.now())
        if (!allowed) throw tooMany(retryAfterSec)
      }),
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * The gate (ADR 0034): every path that makes a user runs it, and it admits one only by
           * claiming an invitation, in one statement. better-auth passes the endpoint it runs in
           * through AsyncLocalStorage. Inside one, only the code sign-in, which proved the
           * address, and a provider's return, whose provider verified it, may make an account;
           * any other, and an address not verified, is refused rather than trusted, so a way in
           * better-auth adds later makes nobody. Outside one is the admin route, which has written
           * the operator's invitation first: a missing context grants nothing by itself, since a
           * refactor or a background task loses it as easily. It refuses by throwing; a `false`
           * would make `createUser` return null, and the sign-in fail on it with an empty 500. On
           * a provider's return better-auth turns the throw into a redirect carrying its code.
           * Whatever the client or the provider sent as a name or picture is dropped, so neither
           * rides in the session cookie, nor reaches a public profile: a profile is the member's
           * to fill.
           */
          before: async (user, context) => {
            const fromProvider = context?.path === PROVIDER_RETURN
            if (context && user.emailVerified !== true) {
              throw fromProvider ? refuseReturn('account_not_linked') : refuse('INVITE_REQUIRED')
            }
            if (context && !fromProvider && context.path !== CODE_SIGN_IN) {
              throw refuse('INVITE_REQUIRED')
            }
            const email = user.email.toLowerCase()
            const now = clock.now()
            if (fromProvider) {
              // Admitted by the code its sign-in carried, and nothing else (ADR 0036): a hold or
              // an operator's invitation is for the code sign-in, which proves the address
              // itself. Someone else may have placed the hold, and only a code from that mailbox
              // should spend it.
              const state = await getOAuthState().catch(() => null)
              const invite = state?.serverContext?.invite
              if (typeof invite !== 'string') throw refuseReturn('invite_required')
              if (!(await claimByCode(db, { code: invite, email, now }))) {
                throw refuseReturn('invite_unavailable')
              }
              return { data: { name: '', image: null } }
            }
            if (!(await claimInvite(db, { email, now }))) {
              throw refuse(
                (await waitsOnFullCode(db, { email, now })) ? 'INVITE_USED' : 'INVITE_REQUIRED',
              )
            }
            return { data: { name: '', image: null } }
          },
          // The profile comes in the same step that creates the account (the Postgres stack did
          // this with a trigger on auth.users). The invitation is settled on its own: a failure
          // there costs the inviter's list a handle for a while, never the member their account,
          // and the next sign-in settles it. An account a provider made is told to its address
          // (ADR 0036), and a notice that fails to go is logged rather than fail the sign-in.
          after: async (user, context) => {
            const now = clock.now()
            await settleInvite(db, { email: user.email, userId: user.id, now }).catch((err) =>
              console.error('invitation not settled', user.id, err),
            )
            await createProfile(db, user.id, now)
            // In the account's language, like every notice, never the browser's: whoever signed in
            // with the provider may not be whoever holds the address.
            const provider: unknown = context?.params?.id
            if (context?.path === PROVIDER_RETURN && typeof provider === 'string') {
              const locale = await accountLocale(db, user.id).catch(() => DEFAULT_UI_LOCALE)
              await mail
                .send(
                  providerAccountMail({
                    to: user.email,
                    provider,
                    publicUrl: config.publicUrl,
                    locale,
                  }),
                )
                .catch((err) => console.error('provider notice not sent', user.id, err))
            }
          },
        },
      },
      // No provider's tokens are kept (ADR 0036): Tela never calls a provider's API, and a token at
      // rest is one more thing to leak.
      account: {
        create: {
          /**
           * A provider linked from Settings is written only for a browser that still holds one of
           * the member's sessions, live in D1 (ADR 0036). The link was started on a fresh session,
           * but better-auth's callback trusts the OAuth state and its cookie alone, and the
           * provider may return ten minutes later: a session that "sign out everywhere", a
           * password change or a reset ended in the meantime would still finish the link it
           * started, and its return would then end every session the member has, the one that
           * cleaned up included. A `false` writes no account, so nothing below runs, and
           * better-auth answers `/settings?error=unable_to_link_account`.
           */
          before: async (_account, context) => {
            if (context?.path !== PROVIDER_RETURN) return { data: NO_TOKENS }
            const link = (await getOAuthState().catch(() => null))?.link
            if (link) {
              const token = await context.getSignedCookie(
                context.context.authCookies.sessionToken.name,
                context.context.secret,
              )
              if (typeof token !== 'string' || !(await isLiveSession(db, link.userId, token))) {
                return false
              }
            }
            return { data: NO_TOKENS }
          },
          /**
           * A provider linked from Settings (`/api/v1/account/link`) is a way in added, and it is
           * added here, at the provider's return: the member's other sessions end, the browser's
           * own, which `before` found live, is kept, and their address is told (ADR 0036). The
           * OAuth state names the member the link was started for, as only the server writes it;
           * an account a provider makes for a new member has no link in its state, and is told in
           * `user.create.after`. Neither failure undoes the link, which is written by then: each
           * is logged.
           */
          after: async (account, context) => {
            if (context?.path !== PROVIDER_RETURN) return
            const link = (await getOAuthState().catch(() => null))?.link
            if (!link) return
            const token = await context.getSignedCookie(
              context.context.authCookies.sessionToken.name,
              context.context.secret,
            )
            await endOtherSessions(db, link.userId, typeof token === 'string' ? token : null).catch(
              (err) => console.error('sessions not ended', link.userId, err),
            )
            await notifyMember(
              deps,
              { id: link.userId, email: link.email },
              { kind: 'linked', provider: account.providerId },
            )
          },
        },
        update: { before: async () => ({ data: NO_TOKENS }) },
      },
      session: {
        create: {
          // A user whose profile insert failed is never created again, so a sign-in repairs it.
          // A repair that fails does not fail the sign-in: a member without a profile is better
          // off than one who cannot sign in to be given one.
          after: async (session) =>
            repairMember(db, session.userId, clock.now()).catch((err) =>
              console.error('member not repaired', session.userId, err),
            ),
        },
      },
    },
    plugins: [
      emailOTP({
        // Sign-up is on so the code sign-in can make an account; the gate above decides whose.
        disableSignUp: false,
        otpLength: 6,
        expiresIn: CODE_SECONDS,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }, ctx) {
          const address = email.toLowerCase()
          const member = await first<{ email_verified: number; ui_locale: string | null }>(
            db,
            sql`select u.email_verified, p.ui_locale from user u
              left join profiles p on p.user_id = u.id where u.email = ${address}`,
          )
          // In the language the asking browser picked (its cookie), else the account's, else the
          // one its Accept-Language prefers (`mail-locale.ts`). better-auth hands an endpoint the
          // request's headers as `ctx.headers`, both for a request and for tela-api's own
          // `auth.api` call, which passes the joiner's two (`routes/invites.ts`); `ctx.request` is
          // there only for a request. A missing context says nothing of the browser: the
          // account's language is used, else English.
          const headers = ctx?.headers ?? ctx?.request?.headers
          const locale = mailLocale({
            cookie: headers?.get('cookie'),
            acceptLanguage: headers?.get('accept-language'),
            account: member?.ui_locale,
          })
          // Two kinds of code are mailed: a sign-in code, and a reset code, which better-auth
          // makes only for an address that has an account. Any other kind (an address check,
          // which nothing in Tela asks for) is deleted unsent; mailed as a sign-in code it would
          // only fail at the sign-in.
          if (type === 'forget-password') {
            if (member)
              await mail.send(
                passwordResetMail({ to: email, code: otp, publicUrl: config.publicUrl, locale }),
              )
            return
          }
          if (type !== 'sign-in') {
            await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${address}`,
            )
            return
          }
          // better-auth calls this for an address with no account only for a sign-in code, and
          // with sign-up on would mail one to any address it is given. Only an address the gate
          // would admit is mailed; for any other the code just stored (the plugin's row
          // `sign-in-otp-<address>`) is deleted, and the endpoint answers as it does for everyone.
          // A throw here would refuse nothing: better-auth logs it and answers the same, with the
          // code left in place.
          let invited = member !== undefined && !member.email_verified
          if (member === undefined) {
            if (!(await holdsInvite(db, { email: address, now: clock.now() }))) {
              await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
                `sign-in-otp-${address}`,
              )
              return
            }
            invited = true
          }
          await mail.send(
            signInMail({ to: email, code: otp, publicUrl: config.publicUrl, invited, locale }),
          )
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
