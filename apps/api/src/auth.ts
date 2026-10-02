/**
 * Sign-in (ADR 0024): better-auth with email codes and passwords, through its Drizzle adapter over
 * the same `TelaDb` everything else uses, so it runs on D1 in production and libSQL in tests. An
 * account is made at an address's first code sign-in, or by the operator's invite, and only for an
 * address that holds an invitation (ADR 0034): `user.create.before` is the gate, and the code mail
 * is sent to nobody else. A password is never how an account starts: it is set on a member a code
 * has proved, and a forgotten one is reset by code (ADR 0036).
 */
import {
  bumpSeq,
  claimInvite,
  consumeLimit,
  currentSeq,
  first,
  holdsInvite,
  type LimitedAction,
  schema,
  settleInvite,
  type TelaDb,
  waitsOnFullCode,
} from '@tela/data'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from './deps'
import { passwordResetMail, signInMail } from './mail'

/** Cookie names start `tela.`; tela-web reads `tela.session_data` to authorize /o and /img. */
export const COOKIE_PREFIX = 'tela'
/** How long a signed session cache is trusted before the session is read from D1 again. */
export const COOKIE_CACHE_SECONDS = 5 * 60
const CODE_SECONDS = 60 * 60
const DAY = 24 * 60 * 60

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

/** Why the gate turns an address away, in the `code` of its 403. */
const REFUSALS = {
  /** Nothing the address holds admits it, or it came a way that makes no account. */
  INVITE_REQUIRED: 'An account is made only for an address that holds an invitation.',
  /** Its hold is on a code that others filled since its code was mailed. */
  INVITE_USED: 'Everyone this invite code was for has joined.',
} as const

const refuse = (code: keyof typeof REFUSALS) =>
  new APIError('FORBIDDEN', { code, message: REFUSALS[code] })

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

export function createAuth(deps: Pick<ApiDeps, 'db' | 'mail' | 'clock' | 'config'>) {
  const { db, mail, clock, config } = deps
  return betterAuth({
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(db, { provider: 'sqlite', schema: schema.authTables }),
    session: {
      expiresIn: 60 * DAY,
      updateAge: DAY,
      // A signed copy of the session in a cookie: tela-api reads no session row for 5 minutes,
      // and tela-web authorizes content objects without D1 at all.
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS, strategy: 'compact' },
      // How recent a sign-in must be for what needs one (adding a way in, ADR 0036). better-auth's
      // default too, said here because the account routes rest on it.
      freshAge: DAY,
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
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Behind Cloudflare every request arrives from Cloudflare; without this every visitor
      // shares one rate-limit bucket (spike S4).
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
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
      // Counted for any address, member or not, keyed as better-auth keys the code (the lowercased
      // address), and refused the same way for all of them, so a 429 says nothing about who has an
      // account. Only requests from outside are counted. tela-api's own calls through `auth.api`
      // carry no request: the operator's invite needs no limit, and a route that lets anyone
      // trigger one must count for itself.
      before: createAuthMiddleware(async (ctx) => {
        const action = PER_ADDRESS.get(ctx.path)
        const email: unknown = ctx.body?.email
        if (!action || !ctx.request || typeof email !== 'string') return
        const address = email.toLowerCase().slice(0, ADDRESS_MAX)
        const { allowed, retryAfterSec } = await consumeLimit(db, action, address, clock.now())
        if (!allowed) {
          throw new APIError(
            'TOO_MANY_REQUESTS',
            { message: TOO_MANY },
            { 'X-Retry-After': String(retryAfterSec) },
          )
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * The gate (ADR 0034): every path that makes a user runs it, and it admits one only by
           * claiming an invitation, in one statement. better-auth passes the endpoint it runs in
           * through AsyncLocalStorage. Inside one, only the code sign-in, which proved the
           * address, may make an account; any other, and an address not verified, is refused
           * rather than trusted, so a way in better-auth adds later makes nobody. Outside one is
           * the admin route, which has written the operator's invitation first: a missing context
           * grants nothing by itself, since a refactor or a background task loses it as easily. It
           * refuses by throwing; a `false` would make `createUser` return null, and the sign-in
           * fail on it with an empty 500. Whatever the client sent as a name or picture is
           * dropped, so neither rides in the session cookie: a profile is the member's to fill.
           */
          before: async (user, context) => {
            if (context && (user.emailVerified !== true || context.path !== '/sign-in/email-otp'))
              throw refuse('INVITE_REQUIRED')
            const email = user.email.toLowerCase()
            const now = clock.now()
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
          // and the next sign-in settles it.
          after: async (user) => {
            const now = clock.now()
            await settleInvite(db, { email: user.email, userId: user.id, now }).catch((err) =>
              console.error('invitation not settled', user.id, err),
            )
            await createProfile(db, user.id, now)
          },
        },
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
          const member = await first<{ email_verified: number }>(
            db,
            sql`select email_verified from user where email = ${address}`,
          )
          // Two kinds of code are mailed: a sign-in code, and a reset code, which better-auth
          // makes only for an address that has an account. Any other kind (an address check,
          // which nothing in Tela asks for) is deleted unsent; mailed as a sign-in code it would
          // only fail at the sign-in.
          if (type === 'forget-password') {
            if (member)
              await mail.send(
                passwordResetMail({ to: email, code: otp, publicUrl: config.publicUrl }),
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
            signInMail({ to: email, code: otp, publicUrl: config.publicUrl, invited }),
          )
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
