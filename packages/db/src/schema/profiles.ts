import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole, authUid, authUsers } from 'drizzle-orm/supabase'

/**
 * One row per auth user, created by the on_auth_user_created trigger (custom migration).
 * Public-readable; only the owner can update.
 */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    uiLocale: text('ui_locale').notNull().default('en'),
    readingLang: text('reading_lang').notNull().default('en'),
    publicSubscriptions: boolean('public_subscriptions').notNull().default(false),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('profiles_handle_key').on(t.handle),
    index('profiles_created_at_idx').on(t.createdAt),
    check('profiles_handle_format', sql`${t.handle} ~ '^[a-z0-9_]{3,30}$'`),
    check('profiles_bio_length', sql`char_length(${t.bio}) <= 280`),
    pgPolicy('profiles_select_public', {
      for: 'select',
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
    pgPolicy('profiles_update_own', {
      for: 'update',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.id}`,
      withCheck: sql`${authUid} = ${t.id}`,
    }),
  ],
)
