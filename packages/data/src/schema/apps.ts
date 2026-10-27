/**
 * Approved apps (ADR 0064): the clients the operator registers, the members who connected them,
 * one row of tokens per device, and the codes in between; and the posts each member opened from
 * blogs they do not follow (ADR 0066). None of it syncs: a member's connections are read live,
 * and tokens are credentials, kept as SHA-256 hashes only and left out of the nightly export.
 */
import {
  APP_END_REASONS,
  APP_NAME_MAX,
  APP_SCOPES,
  APP_STATUSES,
  APP_TEXT_MAX,
  APP_TOKEN_KINDS,
  APP_URL_MAX,
} from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { flag, ms, oneOf, validJson } from './columns'

const CODE_KINDS = ['code', 'device'] as const

export const apps = sqliteTable(
  'apps',
  {
    /** Short and internal: it prefixes the app's mutation ids, so apps cannot replay each other's. */
    id: integer().primaryKey({ autoIncrement: true }),
    /** The public `client_id`, `tela_app_…`. */
    clientId: text().notNull().unique(),
    name: text().notNull(),
    developer: text().notNull(),
    /** Where the operator writes about the app: approval, deprecations, a cut-off. */
    contactEmail: text().notNull(),
    homepageUrl: text(),
    /** The app's own privacy policy, linked on the consent page. */
    privacyUrl: text(),
    /** JSON array of exact redirect URIs; a loopback one matches on any port (RFC 8252). */
    redirectUris: text().notNull().default('[]'),
    /** JSON array of `APP_GRANT_TYPES`; only `code` is built. */
    grantTypes: text().notNull().default('["code"]'),
    /** The most a member may grant it; lowering it narrows live tokens at once. */
    maxScope: text({ enum: APP_SCOPES }).notNull().default('read'),
    /** Whether it may ask to see the member's email address. */
    allowEmail: flag(),
    status: text({ enum: APP_STATUSES }).notNull().default('draft'),
    /** The one account a draft app connects for: its developer's, to test with. */
    ownerUserId: text().references(() => user.id, { onDelete: 'set null' }),
    /** Requests per member per minute, and in all; null is the default, 0 is none. */
    perMemberPerMin: integer(),
    perAppPerMin: integer(),
    /** Members who may hold a live connection at once; null is no limit. */
    maxConnections: integer(),
    notes: text(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    approvedAt: ms(),
    suspendedAt: ms(),
  },
  (t) => [
    check('apps_status_check', oneOf(t.status, APP_STATUSES)),
    check('apps_max_scope_check', oneOf(t.maxScope, APP_SCOPES)),
    check('apps_redirect_uris_check', validJson(t.redirectUris)),
    check('apps_grant_types_check', validJson(t.grantTypes)),
    check('apps_name_check', sql`length(${t.name}) between 1 and ${sql.raw(String(APP_NAME_MAX))}`),
    check(
      'apps_developer_check',
      sql`length(${t.developer}) between 1 and ${sql.raw(String(APP_TEXT_MAX))}`,
    ),
    check(
      'apps_urls_check',
      sql`coalesce(length(${t.homepageUrl}), 0) <= ${sql.raw(String(APP_URL_MAX))}
        and coalesce(length(${t.privacyUrl}), 0) <= ${sql.raw(String(APP_URL_MAX))}`,
    ),
    index('apps_status_idx').on(t.status),
  ],
)

/** A member's connection to one app: what they granted, and when it last acted for them. */
export const appGrants = sqliteTable(
  'app_grants',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    appId: integer()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scope: text({ enum: APP_SCOPES }).notNull(),
    email: flag(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    /** Stamped at most hourly: Settings shows the day. */
    lastUsedAt: ms(),
    endedAt: ms(),
    endReason: text({ enum: APP_END_REASONS }),
  },
  (t) => [
    check('app_grants_scope_check', oneOf(t.scope, APP_SCOPES)),
    check(
      'app_grants_end_reason_check',
      sql`${t.endReason} is null or ${oneOf(t.endReason, APP_END_REASONS)}`,
    ),
    uniqueIndex('app_grants_live_idx').on(t.appId, t.userId).where(sql`${t.endedAt} is null`),
    index('app_grants_user_idx').on(t.userId),
  ],
)

/**
 * One device's tokens under a grant: the current access and refresh hashes. A member running the
 * app on two computers has two rows, each with its own scope, so lowering one leaves the other.
 */
export const appTokens = sqliteTable(
  'app_tokens',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    grantId: integer()
      .notNull()
      .references(() => appGrants.id, { onDelete: 'cascade' }),
    kind: text({ enum: APP_TOKEN_KINDS }).notNull().default('oauth'),
    scope: text({ enum: APP_SCOPES }).notNull(),
    email: flag(),
    accessHash: text().notNull().unique(),
    accessExpiresAt: ms().notNull(),
    refreshHash: text().unique(),
    refreshIdleExpiresAt: ms(),
    /** When the refresh token was last swapped; null before the first swap. */
    rotatedAt: ms(),
    /**
     * Neither the current access token nor the current refresh token has been used since they were
     * made. Only then may a spent refresh token, inside the grace, be swapped again: its answer was
     * lost, not stolen.
     */
    pristine: flag(),
    createdAt: ms().notNull(),
    lastUsedAt: ms(),
    endedAt: ms(),
    endReason: text({ enum: APP_END_REASONS }),
  },
  (t) => [
    check('app_tokens_kind_check', oneOf(t.kind, APP_TOKEN_KINDS)),
    check('app_tokens_scope_check', oneOf(t.scope, APP_SCOPES)),
    check(
      'app_tokens_end_reason_check',
      sql`${t.endReason} is null or ${oneOf(t.endReason, APP_END_REASONS)}`,
    ),
    index('app_tokens_grant_idx').on(t.grantId),
  ],
)

/** Every refresh hash a device has swapped away: one coming back is reuse, and ends the device. */
export const appRefreshSpent = sqliteTable(
  'app_refresh_spent',
  {
    hash: text().primaryKey(),
    tokenId: integer()
      .notNull()
      .references(() => appTokens.id, { onDelete: 'cascade' }),
    replacedAt: ms().notNull(),
  },
  (t) => [index('app_refresh_spent_token_idx').on(t.tokenId)],
)

/** Authorization codes: single use, two minutes, bound to their PKCE challenge and redirect. */
export const appCodes = sqliteTable(
  'app_codes',
  {
    hash: text().primaryKey(),
    kind: text({ enum: CODE_KINDS }).notNull().default('code'),
    appId: integer()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    scope: text({ enum: APP_SCOPES }).notNull(),
    email: flag(),
    redirectUri: text(),
    codeChallenge: text(),
    /** The tokens the exchange made, so a replayed code can end them. */
    mintedTokenId: integer().references(() => appTokens.id, { onDelete: 'set null' }),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
    usedAt: ms(),
  },
  (t) => [
    check('app_codes_kind_check', oneOf(t.kind, CODE_KINDS)),
    check('app_codes_scope_check', oneOf(t.scope, APP_SCOPES)),
    index('app_codes_expires_idx').on(t.expiresAt),
  ],
)

/**
 * Posts a member opened in full from blogs they do not subscribe to, per UTC day (ADR 0066): what
 * `member.unsubscribedPostsPerDay` counts. Swept after two days.
 */
export const postOpens = sqliteTable(
  'post_opens',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** `YYYY-MM-DD`, as `usage_daily.day`. */
    day: text().notNull(),
    contentKey: text().notNull(),
    openedAt: ms().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.day, t.contentKey] }),
    index('post_opens_day_idx').on(t.day),
  ],
)
