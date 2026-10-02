/**
 * Sign-in (ADR 0024): better-auth with email codes only, through its Drizzle adapter over the same
 * `TelaDb` everything else uses, so it runs on D1 in production and libSQL in tests. Registration
 * is closed: an account exists only because an operator invited it (ADR 0015's policy).
 */
import {
  bumpSeq,
  consumeLimit,
  currentSeq,
  first,
  type LimitedAction,
  schema,
  type TelaDb,
} from '@tela/data'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from './deps'
import { signInMail } from './mail'

/** Cookie names start `tela.`; tela-web reads `tela.session_data` to authorize /o and /img. */
export const COOKIE_PREFIX = 'tela'
/** How long a signed session cache is trusted before the session is read from D1 again. */
export const COOKIE_CACHE_SECONDS = 5 * 60
const CODE_SECONDS = 60 * 60
const DAY = 24 * 60 * 60

/**
 * Every endpoint that mails a code to an address or checks one against it, counted per email
 * address as well as per IP (ADR 0036): better-auth's limiter keys on the IP and the path alone.
 * All kinds of code share the two counts, so an address is mailed five codes and has ten guesses
 * checked an hour, whatever the codes are for. The reset steps count like sign-in: they work
 * whether or not passwords are on, and a right reset code gives the account a password. The
 * plugin's change-email pair needs a session and is off; `auth.test.ts` fails on any other. The
 * endpoints `/api/auth` does not serve (`AUTH_ENDPOINTS` in `app.ts`) are counted all the same, so
 * serving one later cannot open it uncounted.
 */
export const PER_ADDRESS = new Map<string, LimitedAction>([
  ['/email-otp/send-verification-otp', 'otpSend'],
  ['/email-otp/request-password-reset', 'otpSend'],
  ['/forget-password/email-otp', 'otpSend'],
  ['/sign-in/email-otp', 'otpVerify'],
  ['/email-otp/check-verification-otp', 'otpVerify'],
  ['/email-otp/verify-email', 'otpVerify'],
  ['/email-otp/reset-password', 'otpVerify'],
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
      .onConflictDoNothing(),
  ])
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
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Behind Cloudflare every request arrives from Cloudflare; without this every visitor
      // shares one rate-limit bucket (spike S4).
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    // Per-isolate memory is useless on Workers: limits live in D1.
    rateLimit: { enabled: true, storage: 'database' },
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
          // Every account gets its profile in the same step that creates it (the Postgres stack
          // did this with a trigger on auth.users).
          after: async (user) => createProfile(db, user.id, clock.now()),
        },
      },
    },
    plugins: [
      emailOTP({
        disableSignUp: true,
        otpLength: 6,
        expiresIn: CODE_SECONDS,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp }) {
          const member = await first<{ email_verified: number }>(
            db,
            sql`select email_verified from user where email = ${email.toLowerCase()}`,
          )
          await mail.send(
            signInMail({
              to: email,
              code: otp,
              publicUrl: config.publicUrl,
              invited: member !== undefined && !member.email_verified,
            }),
          )
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
