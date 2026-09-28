/**
 * better-auth's tables, mirrored column for column from `@better-auth/cli generate` (1.7.x) so one
 * migration system owns the whole database. better-auth talks to D1 itself; Tela's code reads
 * `user` only to join a profile. Column names are better-auth's camelCase, set explicitly because
 * the rest of the schema maps camelCase keys to snake_case.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { ms, seq } from './columns'

/** better-auth writes dates to SQLite as ISO strings in columns it declares as `date`. */
const authDate = customType<{ data: string; driverData: string }>({ dataType: () => 'date' })
const bigint = customType<{ data: number; driverData: number }>({ dataType: () => 'bigint' })

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified').notNull(),
  image: text('image'),
  createdAt: authDate('createdAt').notNull(),
  updatedAt: authDate('updatedAt').notNull(),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: authDate('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: authDate('createdAt').notNull(),
    updatedAt: authDate('updatedAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: authDate('accessTokenExpiresAt'),
    refreshTokenExpiresAt: authDate('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: authDate('createdAt').notNull(),
    updatedAt: authDate('updatedAt').notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: authDate('expiresAt').notNull(),
    createdAt: authDate('createdAt').notNull(),
    updatedAt: authDate('updatedAt').notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const rateLimit = sqliteTable('rateLimit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('lastRequest').notNull(),
})

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
