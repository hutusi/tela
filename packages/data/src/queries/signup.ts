/**
 * The sign-up switch (ADR 0056), as the gates read it: whether a proved address alone makes an
 * account (`signup.mode`), and whether the day's new accounts have reached `signup.maxPerDay`. One
 * statement with the settings inline (`settingSql`), so a switch an operator flips holds from the
 * next request on.
 */
import { parseSetting, reached, type SignupMode, settingDefault } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { first } from '../first'
import { settingSql } from './settings'

const DAY_MS = 24 * 60 * 60 * 1000

/** When the UTC day `now` falls in began. */
export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

/** When the next UTC day begins: when a day's limits are new again. */
export function nextUtcDay(now: number): number {
  return utcDayStart(now) + DAY_MS
}

/**
 * Accounts made since the UTC day of `now` began, as SQL. Counted by their profiles, which Tela
 * stamps with its own clock (better-auth stamps `user.created_at` with the wall clock) and which no
 * account loses, a closed one included: each is written in the step that makes the account, and
 * again by the first sign-in that finds none.
 */
export function accountsTodaySql(now: number): SQL {
  return sql`(select count(*) from profiles where created_at >= ${utcDayStart(now)})`
}

export type SignupState = {
  mode: SignupMode
  /** Open, and today's new accounts have reached `signup.maxPerDay`: joining waits for tomorrow. */
  paused: boolean
  /** Open and not paused: an address proved now makes an account, invited or not. */
  open: boolean
}

/**
 * The switch as it stands at `now`. The day's accounts are counted only while sign-up is open and
 * capped, so the invite mode reads no more than the settings. A stored value that no longer parses
 * reads as the default, as `readSettings` reads it.
 */
export async function signupState(db: TelaDb, now: number): Promise<SignupState> {
  const row = await first<{ mode: unknown; cap: unknown; today: number }>(
    db,
    sql`select m.mode, m.cap,
      case when m.mode = 'open' and m.cap is not null then ${accountsTodaySql(now)} else 0 end
        as today
      from (select ${settingSql('signup.mode')} as mode, ${settingSql('signup.maxPerDay')} as cap) m`,
  )
  const mode = parseSetting('signup.mode', row?.mode)
  const cap = parseSetting('signup.maxPerDay', row?.cap ?? null)
  const open = (mode.ok ? mode.value : settingDefault('signup.mode')) === 'open'
  const limit = cap.ok ? cap.value : settingDefault('signup.maxPerDay')
  const paused = open && reached(limit, Number(row?.today ?? 0))
  return { mode: open ? 'open' : 'invite', paused, open: open && !paused }
}
