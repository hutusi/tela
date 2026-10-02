/**
 * The daily cron (03:17 UTC). Each step is one statement over domain state, so the whole thing is
 * one batch and a missed day is simply caught up by the next.
 */
import { bumpSeq, compactReadStates, currentSeq, pruneInvites, type TelaDb } from '@tela/data'
import { RELAY_REPROBE_DAYS } from '@tela/ingest/region-policy'
import { DEAD_AFTER_ERRORS } from '@tela/ingest/schedule'
import { sql } from 'drizzle-orm'

const DAY = 24 * 3600 * 1000
/** Replayed pushes older than this are not expected; their ids can go. */
export const APPLIED_MUTATIONS_KEEP_DAYS = 30

export type DailyReport = {
  reprobed: number
  revived: number
  prunedRateLimits: number
  prunedMutations: number
  compacted: number
  prunedHolds: number
  prunedSessions: number
  prunedAuthLimits: number
  prunedVerifications: number
}

export async function daily(db: TelaDb, now: number): Promise<DailyReport> {
  const results = await db.batch([
    bumpSeq(db),
    // A feed on the relay for a week is tried directly again; if it still times out, it flips back.
    db.all(sql`
      update feeds set fetch_region = 'global', region_flipped_at = null, timeout_streak = 0,
        updated_at = ${now}, seq = ${currentSeq}
      where fetch_region = 'cn' and region_flipped_at < ${now - RELAY_REPROBE_DAYS * DAY}
      returning id
    `),
    // A dead feed gets another chance once a week, five errors from dying again.
    db.all(sql`
      update feeds set status = 'active', error_count = ${DEAD_AFTER_ERRORS - 5}, next_fetch_at = ${now},
        updated_at = ${now}, seq = ${currentSeq}
      where status = 'dead' and last_fetched_at < ${now - 7 * DAY}
      returning id
    `),
    db.all(sql`delete from action_limits where window_start < ${now - DAY} returning key`),
    db.all(sql`
      delete from applied_mutations where applied_at < ${now - APPLIED_MUTATIONS_KEEP_DAYS * DAY}
      returning mid
    `),
    // A read state under a member's watermark that never held a like says nothing the watermark
    // does not (ADR 0009). One that did keeps when the like last changed, so it stays.
    compactReadStates(db),
    // Personal data with no further use: an address that held an invite and never joined (ADR
    // 0034), a session that has ended (it keeps an IP and a browser), better-auth's per-IP
    // counters, and sign-in codes and OAuth states past their use.
    pruneInvites(db, now),
    db.all(sql`delete from session where expires_at < ${now} returning id`),
    db.all(sql`delete from rate_limit where last_request < ${now - DAY} returning id`),
    db.all(sql`delete from verification where expires_at < ${now} returning id`),
  ])
  const [, reprobed, revived, limits, mutations, compacted, holds, sessions, authLimits, codes] =
    results
  const n = (rows: unknown) => (rows as unknown[]).length
  return {
    reprobed: n(reprobed),
    revived: n(revived),
    prunedRateLimits: n(limits),
    prunedMutations: n(mutations),
    compacted: n(compacted),
    prunedHolds: n(holds),
    prunedSessions: n(sessions),
    prunedAuthLimits: n(authLimits),
    prunedVerifications: n(codes),
  }
}
