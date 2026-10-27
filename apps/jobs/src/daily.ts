/**
 * The daily cron (03:17 UTC). Each step is one statement over domain state, so the whole thing is
 * one batch and a missed day is simply caught up by the next.
 */
import {
  bumpSeq,
  compactReadStates,
  currentSeq,
  pruneInvites,
  type TelaDb,
  utcDay,
} from '@tela/data'
import { RELAY_REPROBE_DAYS } from '@tela/ingest/region-policy'
import { DEAD_AFTER_ERRORS } from '@tela/ingest/schedule'
import { REFRESH_IDLE_MS } from '@tela/shared'
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
  prunedOpens: number
  /**
   * Apps' expired codes; tokens a month after they ended, or after both their access and refresh
   * tokens could last be used; spent refresh hashes past use; and connections a month after they
   * ended.
   */
  prunedAppCodes: number
  prunedAppTokens: number
  prunedSpentRefresh: number
  prunedAppGrants: number
}

/** How long a device's tokens, and a connection's record, are kept once nothing can use them. */
export const APP_RECORDS_KEEP_DAYS = 30

export async function daily(db: TelaDb, now: number): Promise<DailyReport> {
  const keptSince = now - APP_RECORDS_KEEP_DAYS * DAY
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
    // Counted, then deleted: a counter per app and minute (ADR 0064) makes the rows returned as
    // many as the rows, where a count is one. The batch is atomic, so the two agree.
    db.all(sql`select count(*) as n from action_limits where window_start < ${now - DAY}`),
    db.run(sql`delete from action_limits where window_start < ${now - DAY}`),
    db.all(sql`
      delete from applied_mutations where applied_at < ${now - APPLIED_MUTATIONS_KEEP_DAYS * DAY}
      returning mid
    `),
    // A read state under a member's watermark that never held a like says nothing the watermark
    // does not (ADR 0009). One that did keeps when the like last changed, so it stays, and so does
    // a read or unread chosen by hand, which beats the watermark.
    compactReadStates(db),
    // Personal data with no further use: an address that held an invite and never joined (ADR
    // 0034), a session that has ended (it keeps an IP and a browser), better-auth's per-IP
    // counters, and sign-in codes and OAuth states past their use.
    pruneInvites(db, now),
    db.all(sql`delete from session where expires_at < ${now} returning id`),
    db.all(sql`delete from rate_limit where last_request < ${now - DAY} returning id`),
    db.all(sql`delete from verification where expires_at < ${now} returning id`),
    // Posts opened from blogs a member does not follow (ADR 0066): only today's count decides
    // anything, and the privacy page promises a two-day record, so the day before yesterday goes.
    db.all(sql`select count(*) as n from post_opens where day <= ${utcDay(now - 2 * DAY)}`),
    db.run(sql`delete from post_opens where day <= ${utcDay(now - 2 * DAY)}`),
    // Apps' credentials past any use (ADR 0064): codes that expired, and a device's tokens a month
    // after they ended, or a month after the last moment either could be used, its access token
    // expired and its refresh token idle past its limit (or never issued): a device that stopped
    // and never came back. Their spent refresh hashes go with them, by cascade. A spent hash older
    // than the refresh idle limit can no longer be told from a token never issued, so it goes too.
    db.all(sql`delete from app_codes where expires_at < ${now} returning hash`),
    db.all(sql`
      delete from app_tokens where ended_at < ${keptSince}
        or (ended_at is null and access_expires_at < ${keptSince}
          and coalesce(refresh_idle_expires_at, 0) < ${keptSince})
      returning id
    `),
    db.all(sql`
      delete from app_refresh_spent where replaced_at < ${now - REFRESH_IDLE_MS} returning hash
    `),
    // A connection the member or the operator ended is kept a month, then goes (the privacy page:
    // until you disconnect, then 30 days), with any token still under it, by cascade.
    db.all(sql`delete from app_grants where ended_at < ${keptSince} returning id`),
  ])
  const [
    ,
    reprobed,
    revived,
    limits,
    ,
    mutations,
    compacted,
    holds,
    sessions,
    authLimits,
    codes,
    opens,
    ,
    appCodes,
    appTokens,
    spentRefresh,
    appGrants,
  ] = results
  const n = (rows: unknown) => (rows as unknown[]).length
  const count = (rows: unknown) => Number((rows as { n?: unknown }[])[0]?.n ?? 0)
  return {
    reprobed: n(reprobed),
    revived: n(revived),
    prunedRateLimits: count(limits),
    prunedMutations: n(mutations),
    compacted: n(compacted),
    prunedHolds: n(holds),
    prunedSessions: n(sessions),
    prunedAuthLimits: n(authLimits),
    prunedVerifications: n(codes),
    prunedOpens: count(opens),
    prunedAppCodes: n(appCodes),
    prunedAppTokens: n(appTokens),
    prunedSpentRefresh: n(spentRefresh),
    prunedAppGrants: n(appGrants),
  }
}
