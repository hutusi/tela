/**
 * better-auth's tables, mirrored from `auth generate` (the better-auth 1.7 CLI) for its Drizzle
 * adapter on SQLite, so one migration system owns the whole database and better-auth goes through
 * the same `Db` seam as everything else: D1 in production, libSQL in tests and on the exit path
 * (ADR 0024). Dates are epoch milliseconds, as everywhere in Tela. Regenerate with
 * `bunx auth@<version> generate` when better-auth is upgraded, and compare.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { ms, seq } from './columns'

const stamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: stamp('created_at').notNull(),
  updatedAt: stamp('updated_at')
    .$onUpdate(() => new Date())
    .notNull(),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: stamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: stamp('created_at').notNull(),
    updatedAt: stamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: stamp('access_token_expires_at'),
    refreshTokenExpiresAt: stamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: stamp('created_at').notNull(),
    updatedAt: stamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: stamp('expires_at').notNull(),
    createdAt: stamp('created_at').notNull(),
    updatedAt: stamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

/** better-auth's own limiter for its endpoints (sign-in codes); Tela's are `action_limits`. */
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

/** What the auth adapter is given: better-auth's models, by the names it looks them up by. */
export const authTables = { user, session, account, verification, rateLimit }

/**
 * One per member, created with the account by the invite command (there is no trigger on a user
 * table any more). The handle rule used to be a Postgres regex; SQLite has GLOB.
 */
export const profiles = sqliteTable(
  'profiles',
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    handle: text().notNull().unique(),
    displayName: text(),
    bio: text(),
    uiLocale: text(),
    readingLang: text(),
    publicSubscriptions: integer({ mode: 'boolean' }).notNull().default(false),
    isAdmin: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    check(
      'profiles_handle_check',
      sql`length(${t.handle}) between 3 and 30 and ${t.handle} not glob '*[^a-z0-9_]*'`,
    ),
    check('profiles_bio_check', sql`${t.bio} is null or length(${t.bio}) <= 280`),
  ],
)

/** Per-member reader settings (theme, typography, display mode), synced like any other row. */
export const userPrefs = sqliteTable(
  'user_prefs',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    valueJson: text().notNull(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    check('user_prefs_value_json_check', sql`json_valid(${t.valueJson})`),
  ],
)
