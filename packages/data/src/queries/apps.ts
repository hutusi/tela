/**
 * Approved apps (ADR 0064): the statements that end connections, which every path that ends a
 * member's other sessions adds to its own batch, and the secrets and hashes tokens are made of;
 * then the authorization server's own writes: a member's approval, the code exchange, the refresh
 * swap, revocation, and resolving an access token to the member and app it acts for.
 *
 * Every write that decides something is one conditional statement, or one batch, that says what it
 * did through `RETURNING` (AGENTS invariants 3 and 5): two requests racing with one code or one
 * refresh token are told apart by the database, never by a read first.
 */
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  APP_DEFAULT_PER_APP_PER_MIN,
  APP_DEFAULT_PER_MEMBER_PER_MIN,
  type AppEndReason,
  type AppScope,
  type AppStatus,
  AUTH_CODE_TTL_MS,
  CLIENT_ID_PREFIX,
  type Connection,
  lowerScope,
  REFRESH_GRACE_MS,
  REFRESH_IDLE_MS,
  REFRESH_TOKEN_PREFIX,
} from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { ACTION_LIMITS } from './limits'
import { settingSql } from './settings'
import { standingOk } from './standing'

/**
 * End every live connection a member has, and each device's tokens under them, for `reason`. Two
 * statements, tokens first, for the caller's own batch: wherever Tela ends a member's other
 * sessions (password, provider link, sign out everywhere, the console's sign-out and suspension,
 * closing the account), their apps stop in the same commit. `onlyIf` (true as SQL) holds both to a
 * condition the batch decides, as a suspension ends sessions only while it holds.
 */
export function endConnections(
  db: TelaDb,
  userId: string,
  reason: AppEndReason,
  now: number,
  onlyIf: SQL = sql`1`,
) {
  return [
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = ${reason}
      where ended_at is null and ${onlyIf}
        and grant_id in (select id from app_grants where user_id = ${userId} and ended_at is null)
    `),
    db.run(sql`
      update app_grants set ended_at = ${now}, end_reason = ${reason}, updated_at = ${now}
      where user_id = ${userId} and ended_at is null and ${onlyIf}
    `),
  ] as const
}

/**
 * End the live connections to the apps `apps` selects (a parenthesised SQL set of app ids), and
 * each device's tokens under them, for `reason`: everyone's, or everyone's but `except`'s. Two
 * statements, tokens first, for the caller's batch; `onlyIf` (true as SQL) holds both to a
 * condition the batch decides.
 */
function endConnectionsTo(
  db: TelaDb,
  apps: SQL,
  reason: AppEndReason,
  now: number,
  options: { except?: SQL; onlyIf?: SQL } = {},
) {
  const except = options.except ? sql`and user_id is not ${options.except}` : sql``
  const onlyIf = options.onlyIf ?? sql`1`
  return [
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = ${reason}
      where ended_at is null and ${onlyIf} and grant_id in (select id from app_grants
        where app_id in ${apps} and ended_at is null ${except})
    `),
    db.run(sql`
      update app_grants set ended_at = ${now}, end_reason = ${reason}, updated_at = ${now}
      where app_id in ${apps} and ended_at is null ${except} and ${onlyIf}
    `),
  ] as const
}

/** End every live connection to one app, for everyone: the operator's "End all connections". */
export function endAppConnections(db: TelaDb, appId: number, reason: AppEndReason, now: number) {
  return endConnectionsTo(db, sql`(${appId})`, reason, now)
}

/**
 * End every other member's connection to one app, its developer keeping their own (ADR 0067):
 * an app taken back to Testing, which only its developer may connect. Only while `onlyIf` holds,
 * which the caller's batch decides after the move it makes.
 */
export function endOthersConnections(
  db: TelaDb,
  appId: number,
  reason: AppEndReason,
  now: number,
  onlyIf: SQL,
) {
  return endConnectionsTo(db, sql`(${appId})`, reason, now, {
    except: sql`(select developer_id from apps where id = ${appId})`,
    onlyIf,
  })
}

/**
 * End every live connection to the apps a member registered (ADR 0067), as the operator's "End
 * all connections" does: what closing the developer's account does to them.
 */
export function endDeveloperConnections(
  db: TelaDb,
  developerId: string,
  reason: AppEndReason,
  now: number,
) {
  const apps = sql`(select id from apps where developer_id = ${developerId})`
  return endConnectionsTo(db, apps, reason, now)
}

/** `bytes` random bytes as unpadded base64url. Web Crypto: workerd, Node 24 and Bun alike. */
export function randomSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  let binary = ''
  for (const b of buffer) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** A new access token, refresh token or authorization code. Shown once; only its hash is kept. */
export const newAccessToken = () => `${ACCESS_TOKEN_PREFIX}${randomSecret()}`
export const newRefreshToken = () => `${REFRESH_TOKEN_PREFIX}${randomSecret()}`
export const newAuthCode = () => randomSecret()
/** A new app's public `client_id`. */
export const newClientId = () => `${CLIENT_ID_PREFIX}${randomSecret(12)}`

/** SHA-256 of a secret, lowercase hex: what `app_tokens`, `app_refresh_spent` and `app_codes` hold. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** PKCE's S256 (RFC 7636 §4.2): unpadded base64url of the verifier's SHA-256. */
export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------------------------
// What a token, a code or a refresh may act through

const HOUR_MS = 60 * 60 * 1000

/**
 * True (as SQL) while the developer of the app `alias` names, if a member registered it, is in
 * good standing (ADR 0067). A developer with no profile row is not barred, as `isBarred` reads it.
 */
export function developerOk(alias: string): SQL {
  const a = sql.raw(alias)
  return sql`not exists (select 1 from profiles dev_p where dev_p.user_id = ${a}.developer_id
    and not ${standingOk('dev_p')})`
}

/**
 * True (as SQL) for an app, `alias` in the query, that is cut off: by the operator (`suspended`),
 * or because its developer is suspended or closed (ADR 0067), which answers the same way. Its
 * connections and tokens are kept either way, so lifting either brings it back.
 */
export function appCutOff(alias: string): SQL {
  return sql`(${sql.raw(alias)}.status = 'suspended' or not ${developerOk(alias)})`
}

/**
 * True (as SQL) for an app, `alias` in the query, that may act for the member `userId` names: an
 * approved app, or a draft of the member's own, whose developer is in good standing. A suspended
 * app acts for nobody. `developer` names the developer's profile when the query already joins it
 * (left, on `developer_id`): a row with no developer, all nulls, passes `standingOk` as it is.
 */
function usableFor(alias: string, userId: SQL, developer?: string): SQL {
  const a = sql.raw(alias)
  const standing = developer ? standingOk(developer) : developerOk(alias)
  return sql`((${a}.status = 'approved' or (${a}.status = 'draft' and ${a}.owner_user_id = ${userId}))
    and ${standing})`
}

/**
 * True (as SQL) when the app `alias` names may let a member see their address (ADR 0067): the
 * operator allows it, and Tela reviewed the app, which no edit since has undone. What the consent
 * page offers, what a token resolves to, and what Connected apps and the export say all read it.
 */
export function emailAllowed(alias: string): SQL {
  const a = sql.raw(alias)
  return sql`(${a}.allow_email = 1 and ${a}.reviewed_at is not null)`
}

/**
 * The most members the app `alias` names may hold at once, as SQL; null for no cap (ADR 0067).
 * A reviewed app has its own (`max_connections`); one Tela has not reviewed, the lower of its own
 * and `apps.unreviewedMaxConnections`, either of which may be null. A `CASE`, never `min()`,
 * which is null as soon as either side is: no cap at all.
 */
export function effectiveMaxConnections(alias: string): SQL {
  const a = sql.raw(alias)
  const setting = settingSql('apps.unreviewedMaxConnections')
  return sql`(case when ${a}.reviewed_at is not null then ${a}.max_connections
    when ${a}.max_connections is null then ${setting}
    when ${setting} is null then ${a}.max_connections
    when ${a}.max_connections < ${setting} then ${a}.max_connections
    else ${setting} end)`
}

/**
 * True (as SQL) for a live connection, `grant` in the statement, that counts against the cap of
 * the app `alias` names: one to the app itself; and, for an unreviewed app a member registered,
 * one to any of that developer's unreviewed apps, so spreading members over several `client_id`s
 * gains nothing. The developer's own connection never counts.
 */
function countsToward(alias: string, grant: string): SQL {
  const a = sql.raw(alias)
  const g = sql.raw(grant)
  return sql`(${g}.ended_at is null and ${g}.user_id is not ${a}.developer_id
    and (${g}.app_id = ${a}.id or (${a}.reviewed_at is null and ${a}.developer_id is not null
      and ${g}.app_id in (select o.id from apps o
        where o.developer_id = ${a}.developer_id and o.reviewed_at is null))))`
}

/** The members counted against the app `alias` names now (`countsToward`), each once, as SQL. */
export function connectionsCounted(alias: string): SQL {
  return sql`(select count(distinct cg.user_id) from app_grants cg
    where ${countsToward(alias, 'cg')})`
}

/**
 * True (as SQL) when the app `alias` names has room for the member `userId` names: its developer,
 * a member it already counts (connected to it, or to another app sharing its cap), or a place
 * under its cap (`effectiveMaxConnections`). What the consent page checks, and what the approval
 * holds in its one statement, should two approvals race.
 */
function hasRoom(alias: string, userId: SQL): SQL {
  const a = sql.raw(alias)
  const cap = effectiveMaxConnections(alias)
  return sql`(${a}.developer_id is ${userId}
    or exists (select 1 from app_grants rg where ${countsToward(alias, 'rg')}
      and rg.user_id = ${userId})
    or ${cap} is null
    or ${connectionsCounted(alias)} < ${cap})`
}

/** True (as SQL) while the operator lets apps act at all (`apps.enabled`, ADR 0064). */
const appsOn = () => sql`(${settingSql('apps.enabled')} = 'on')`

/** A token pair as handed to an app once; only the hashes are kept. */
type Minted = { accessToken: string; refreshToken: string; accessHash: string; refreshHash: string }

async function mintPair(): Promise<Minted> {
  const accessToken = newAccessToken()
  const refreshToken = newRefreshToken()
  return {
    accessToken,
    refreshToken,
    accessHash: await sha256Hex(accessToken),
    refreshHash: await sha256Hex(refreshToken),
  }
}

/** What the token endpoint answers (RFC 6749 §5.1), but for its names. */
export type IssuedTokens = {
  accessToken: string
  refreshToken: string
  /** Seconds. */
  expiresIn: number
  scope: AppScope
  email: boolean
}

const issued = (pair: Minted, row: { scope: AppScope; email: number }): IssuedTokens => ({
  accessToken: pair.accessToken,
  refreshToken: pair.refreshToken,
  expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
  scope: row.scope,
  email: row.email === 1,
})

// ---------------------------------------------------------------------------------------------
// The consent page

/** The app a consent request names, with what the member already holds of it. */
export type ConsentApp = {
  id: number
  clientId: string
  name: string
  developer: string
  homepageUrl: string | null
  privacyUrl: string | null
  redirectUris: string[]
  grantTypes: string[]
  maxScope: AppScope
  /** It may let a member see their address (`emailAllowed`): allowed, and reviewed. */
  emailAllowed: boolean
  status: AppStatus
  /** Cut off (`appCutOff`): by the operator, or because its developer is barred (ADR 0067). */
  cutOff: boolean
  ownerUserId: string | null
  /** The most members it may hold at once (`effectiveMaxConnections`); null for no cap. */
  maxConnections: number | null
  /** Tela reviewed it (ADR 0067). */
  reviewed: boolean
  /** The handle of the member who registered it; null for an app the operator registered. */
  developerHandle: string | null
  /** The member holds a live connection to it. */
  connected: boolean
  /** Members counted against its cap now (`connectionsCounted`). */
  connections: number
  /**
   * Its cap has room for the member (`hasRoom`): they are its developer, it already counts them,
   * or a place is free. The approval holds the same condition in its own statement.
   */
  room: boolean
}

const jsonList = (text: string): string[] => {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** The app with `clientId`, as the consent page's checks need it, or undefined for none. */
export async function readConsentApp(
  db: TelaDb,
  clientId: string,
  userId: string,
): Promise<ConsentApp | undefined> {
  const rows = await db.all<{
    id: number
    client_id: string
    name: string
    developer: string
    homepage_url: string | null
    privacy_url: string | null
    redirect_uris: string
    grant_types: string
    max_scope: AppScope
    email_allowed: number
    status: AppStatus
    cut_off: number
    owner_user_id: string | null
    max_connections: number | null
    reviewed: number
    developer_handle: string | null
    connected: number
    connections: number
    room: number
  }>(sql`
    select a.id, a.client_id, a.name, a.developer, a.homepage_url, a.privacy_url, a.redirect_uris,
      a.grant_types, a.max_scope, ${emailAllowed('a')} as email_allowed, a.status,
      ${appCutOff('a')} as cut_off, a.owner_user_id,
      ${effectiveMaxConnections('a')} as max_connections,
      (a.reviewed_at is not null) as reviewed,
      (select p.handle from profiles p where p.user_id = a.developer_id) as developer_handle,
      exists (select 1 from app_grants g where g.app_id = a.id and g.user_id = ${userId}
        and g.ended_at is null) as connected,
      ${connectionsCounted('a')} as connections,
      ${hasRoom('a', sql`${userId}`)} as room
    from apps a where a.client_id = ${clientId}
  `)
  const row = rows[0]
  if (!row) return undefined
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    developer: row.developer,
    homepageUrl: row.homepage_url,
    privacyUrl: row.privacy_url,
    redirectUris: jsonList(row.redirect_uris),
    grantTypes: jsonList(row.grant_types),
    maxScope: row.max_scope,
    emailAllowed: row.email_allowed === 1,
    status: row.status,
    cutOff: row.cut_off === 1,
    ownerUserId: row.owner_user_id,
    maxConnections: row.max_connections,
    reviewed: row.reviewed === 1,
    developerHandle: row.developer_handle,
    connected: row.connected === 1,
    connections: row.connections,
    room: row.room === 1,
  }
}

/**
 * A member approves an app: their live connection to it is made, or updated to what they chose
 * this time (one per app and member, the partial unique index), and a code is minted for the
 * redirect and PKCE challenge the request named. One batch. The connection is made only while the
 * app may act for the member and its cap has room for them (`hasRoom`: its developer and a member
 * already counted always have, ADR 0067), with the setting read inline, so of two approvals
 * racing for the last place one connects; the code only beside a live connection. Null when
 * either refused: the caller asks the request's checks again for the reason.
 */
export async function approveConnection(
  db: TelaDb,
  input: {
    appId: number
    userId: string
    scope: AppScope
    email: boolean
    redirectUri: string
    codeChallenge: string
    now: number
  },
): Promise<{ code: string } | null> {
  const { appId, userId, now } = input
  const code = newAuthCode()
  const hash = await sha256Hex(code)
  const email = input.email ? 1 : 0
  const [, minted] = (await db.batch([
    db.run(sql`
      insert into app_grants (app_id, user_id, scope, email, created_at, updated_at)
      select ${appId}, ${userId}, ${input.scope}, ${email}, ${now}, ${now}
      where exists (select 1 from apps a where a.id = ${appId} and ${usableFor('a', sql`${userId}`)}
        and ${hasRoom('a', sql`${userId}`)})
      on conflict (app_id, user_id) where ended_at is null
      do update set scope = excluded.scope, email = excluded.email, updated_at = excluded.updated_at
    `),
    db.all<{ hash: string }>(sql`
      insert into app_codes (hash, kind, app_id, user_id, scope, email, redirect_uri, code_challenge,
        created_at, expires_at)
      select ${hash}, 'code', ${appId}, ${userId}, ${input.scope}, ${email}, ${input.redirectUri},
        ${input.codeChallenge}, ${now}, ${now + AUTH_CODE_TTL_MS}
      where exists (select 1 from app_grants where app_id = ${appId} and user_id = ${userId}
          and ended_at is null)
        and exists (select 1 from apps a where a.id = ${appId} and ${usableFor('a', sql`${userId}`)})
      returning hash
    `),
  ])) as unknown as [unknown, { hash: string }[]]
  return minted.length > 0 ? { code } : null
}

// ---------------------------------------------------------------------------------------------
// The token endpoint

/**
 * Exchange an authorization code for a device's tokens (RFC 6749 §4.1.3, PKCE per RFC 7636), in
 * one batch:
 *
 * 1. A replay ends the tokens the code made: a code coming back with its own client, redirect and
 *    verifier, once spent, was seen by someone else, and RFC 6749 §10.5 asks for exactly this. A
 *    code shown without its verifier ends nothing, so a stranger who saw it in a log cannot cut
 *    the member's app off.
 * 2. The code is spent by one conditional update: unspent, unexpired, bound to this client,
 *    redirect and verifier, the app still usable for the member, the member in good standing, and
 *    a live connection made no later than the code (a code from before a connection ended does
 *    not join the next one).
 * 3. The device's tokens are inserted only if that update matched, under the live connection.
 * 4. The code records them, for step 1 on a replay.
 *
 * Null for every refusal: the endpoint answers `invalid_grant`, whichever binding failed.
 */
export async function exchangeCode(
  db: TelaDb,
  input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
    now: number
  },
): Promise<IssuedTokens | null> {
  const { clientId, redirectUri, now } = input
  const hash = await sha256Hex(input.code)
  const challenge = await pkceS256(input.codeVerifier)
  const pair = await mintPair()
  const results = (await db.batch([
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = 'reuse'
      where ended_at is null and access_hash <> ${pair.accessHash}
        and id = (select c.minted_token_id from app_codes c join apps a on a.id = c.app_id
          where c.hash = ${hash} and a.client_id = ${clientId} and c.redirect_uri = ${redirectUri}
            and c.code_challenge = ${challenge})
    `),
    db.run(sql`
      update app_codes set used_at = ${now}
      where hash = ${hash} and kind = 'code' and used_at is null and expires_at > ${now}
        and redirect_uri = ${redirectUri} and code_challenge = ${challenge}
        and app_id = (select a.id from apps a where a.client_id = ${clientId}
          and ${usableFor('a', sql`app_codes.user_id`)})
        and exists (select 1 from profiles p where p.user_id = app_codes.user_id
          and ${standingOk('p')})
        and exists (select 1 from app_grants g where g.app_id = app_codes.app_id
          and g.user_id = app_codes.user_id and g.ended_at is null
          and g.created_at <= app_codes.created_at)
    `),
    db.all<{ id: number; scope: AppScope; email: number }>(sql`
      insert into app_tokens (grant_id, kind, scope, email, access_hash, access_expires_at,
        refresh_hash, refresh_idle_expires_at, pristine, created_at)
      select g.id, 'oauth', c.scope, c.email, ${pair.accessHash}, ${now + ACCESS_TOKEN_TTL_MS},
        ${pair.refreshHash}, ${now + REFRESH_IDLE_MS}, 1, ${now}
      from app_codes c
      join app_grants g on g.app_id = c.app_id and g.user_id = c.user_id and g.ended_at is null
      where c.hash = ${hash} and c.used_at = ${now} and c.minted_token_id is null
      returning id, scope, email
    `),
    db.run(sql`
      update app_codes set minted_token_id =
        (select id from app_tokens where access_hash = ${pair.accessHash})
      where hash = ${hash} and minted_token_id is null
        and exists (select 1 from app_tokens where access_hash = ${pair.accessHash})
    `),
  ])) as unknown as [unknown, unknown, { id: number; scope: AppScope; email: number }[], unknown]
  const token = results[2][0]
  return token ? issued(pair, token) : null
}

/**
 * True (as SQL) when `hash` is the refresh token the device, `alias` in the statement, swapped away
 * last, within the grace, and neither of its replacements has been used since: the answer to that
 * swap was lost, not stolen. Only the one before the current token: any earlier one is reuse.
 */
function lostAnswer(alias: string, hash: string, now: number): SQL {
  const t = sql.raw(alias)
  return sql`(${t}.pristine = 1 and exists (select 1 from app_refresh_spent s
    where s.hash = ${hash} and s.token_id = ${t}.id and s.replaced_at = ${t}.rotated_at
      and s.replaced_at > ${now - REFRESH_GRACE_MS}))`
}

/**
 * True (as SQL) for a device's tokens, `alias` in the statement, that the refresh token hashed
 * `hash` may swap now, for `clientId`: live, used within the last 90 days, under a live connection
 * to an app still usable for a member in good standing; and either the device's current refresh
 * token, or a lost answer's (`lostAnswer`), retried.
 */
function swappable(alias: string, input: { hash: string; clientId: string; now: number }): SQL {
  const t = sql.raw(alias)
  const { hash, now } = input
  return sql`${t}.ended_at is null and ${t}.refresh_idle_expires_at > ${now}
    and ${t}.grant_id in (select g.id from app_grants g join apps a on a.id = g.app_id
      join profiles p on p.user_id = g.user_id
      where g.ended_at is null and a.client_id = ${input.clientId}
        and ${usableFor('a', sql`g.user_id`)} and ${standingOk('p')})
    and (${t}.refresh_hash = ${hash} or ${lostAnswer(alias, hash, now)})`
}

export type Rotated = { ok: true; tokens: IssuedTokens } | { ok: false; reuse: boolean }

/**
 * Swap a refresh token for a new pair (RFC 6749 §6, rotated per OAuth 2.1), in one batch:
 *
 * 1. The hash being replaced is kept in `app_refresh_spent`, only if the swap below will match.
 * 2. One conditional update swaps both hashes (`swappable`), and says through `RETURNING` whether
 *    it did: of two requests racing with one token, exactly one finds the current hash.
 * 3. Otherwise a spent hash coming back ends the device it belonged to (`reuse`): someone else
 *    holds a token the device let go. The one exception is a lost answer: the token swapped away
 *    last, within the grace, and only while its replacements are unused, is swapped again by
 *    step 2. That exception is also the race's loser: it gets a pair too, and the winner's pair,
 *    replaced before it was used, stops working.
 *
 * An idle-expired token, a stranger's, or one whose connection or app is no longer usable is
 * simply refused, ending nothing.
 */
export async function rotateRefresh(
  db: TelaDb,
  input: { refreshToken: string; clientId: string; now: number },
): Promise<Rotated> {
  const { now } = input
  const hash = await sha256Hex(input.refreshToken)
  const pair = await mintPair()
  const match = { hash, clientId: input.clientId, now }
  const results = (await db.batch([
    db.run(sql`
      insert into app_refresh_spent (hash, token_id, replaced_at)
      select t.refresh_hash, t.id, ${now} from app_tokens t
      where t.refresh_hash is not null and ${swappable('t', match)}
      on conflict (hash) do nothing
    `),
    db.all<{ id: number; scope: AppScope; email: number }>(sql`
      update app_tokens set access_hash = ${pair.accessHash},
        access_expires_at = ${now + ACCESS_TOKEN_TTL_MS}, refresh_hash = ${pair.refreshHash},
        refresh_idle_expires_at = ${now + REFRESH_IDLE_MS}, rotated_at = ${now}, pristine = 1
      where ${swappable('app_tokens', match)}
      returning id, scope, email
    `),
    db.all<{ id: number }>(sql`
      update app_tokens set ended_at = ${now}, end_reason = 'reuse'
      where ended_at is null
        and id in (select token_id from app_refresh_spent where hash = ${hash})
        and not ${lostAnswer('app_tokens', hash, now)}
        and not exists (select 1 from app_tokens n where n.refresh_hash = ${pair.refreshHash})
      returning id
    `),
  ])) as unknown as [unknown, { id: number; scope: AppScope; email: number }[], { id: number }[]]
  const token = results[1][0]
  if (token) return { ok: true, tokens: issued(pair, token) }
  return { ok: false, reuse: results[2].length > 0 }
}

/**
 * Revoke a token (RFC 7009): the device whose current access or refresh token it is, if the token
 * was issued to `clientId`, ends with both. True when one ended; the endpoint answers 200 either
 * way, as the RFC asks.
 */
export async function revokeToken(
  db: TelaDb,
  input: { token: string; clientId: string; now: number },
): Promise<boolean> {
  const hash = await sha256Hex(input.token)
  const ended = await db.all<{ id: number }>(sql`
    update app_tokens set ended_at = ${input.now}, end_reason = 'revoked'
    where ended_at is null and (access_hash = ${hash} or refresh_hash = ${hash})
      and grant_id in (select g.id from app_grants g join apps a on a.id = g.app_id
        where a.client_id = ${input.clientId})
    returning id
  `)
  return ended.length > 0
}

// ---------------------------------------------------------------------------------------------
// Resolving a bearer token

/** Who an access token acts for: never admin, whatever the member is (ADR 0064). */
export type AppPrincipal = {
  userId: string
  appId: number
  clientId: string
  grantId: number
  tokenId: number
  /** The lower of the token's and the app's ceiling, so lowering an app reaches live tokens. */
  scope: AppScope
  /** The member granted it, and the app may ask (`emailAllowed`: allowed, and reviewed). */
  email: boolean
}

export type ResolvedToken =
  | { ok: true; principal: AppPrincipal }
  | { ok: false; error: 'invalid_token' | 'apps_paused' | 'app_suspended' }
  | { ok: false; error: 'rate_limited'; retryAfterSec: number }

type Found = {
  token_id: number
  token_scope: AppScope
  token_email: number
  grant_id: number
  grant_scope: AppScope
  grant_email: number
  user_id: string
  app_id: number
  client_id: string
  max_scope: AppScope
  email_allowed: number
  per_member_per_min: number | null
  per_app_per_min: number | null
  cut_off: number
  usable: number
  enabled: number
}

/** The fixed window `action` counts `now` in, as `consumeLimit` keys it. */
function windowOf(action: 'appMember' | 'appTotal', now: number) {
  const ms = ACTION_LIMITS[action].windowSec * 1000
  const start = Math.floor(now / ms) * ms
  return { start, end: start + ms }
}

const secondsUntil = (end: number, now: number) => Math.max(1, Math.ceil((end - now) / 1000))

/**
 * Resolve an access token to the member and app it acts for, in one batch that also does what
 * every call through it costs:
 *
 * 1. the token, its connection, the app, the member's profile and the app's developer's, read
 *    together: the app must be approved (or a draft of this member's), its developer in good
 *    standing (ADR 0067), `apps.enabled` on, and the member in good standing;
 * 2. the app's requests counted for this member and in all (`appMember`, `appTotal`, as
 *    `consumeLimit` keys them), each held to the app's own limit or the default (0 is none);
 * 3. the device marked used, so a spent refresh token is never again a lost answer (`pristine`);
 * 4. when it was last used, on the device and the connection, stamped at most hourly.
 *
 * Steps 2 to 4 write only for a token step 1 accepts, so a refused token counts and stamps
 * nothing. A call over a limit is still counted and still stamps: it was made.
 */
export async function resolveToken(
  db: TelaDb,
  accessToken: string,
  now: number,
): Promise<ResolvedToken> {
  if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) return { ok: false, error: 'invalid_token' }
  const hash = await sha256Hex(accessToken)
  const member = windowOf('appMember', now)
  const total = windowOf('appTotal', now)
  // The developer's profile (`dp`) is joined once, left: an app the operator registered has none.
  const held = sql`app_tokens t join app_grants g on g.id = t.grant_id
    join apps a on a.id = g.app_id join profiles p on p.user_id = g.user_id
    left join profiles dp on dp.user_id = a.developer_id`
  const current = sql`t.access_hash = ${hash} and t.ended_at is null
    and t.access_expires_at > ${now} and g.ended_at is null`
  const usable = sql`(${usableFor('a', sql`g.user_id`, 'dp')} and ${standingOk('p')})`
  const live = sql`${current} and ${usable} and ${appsOn()}`
  const stale = now - HOUR_MS
  const [found, memberCount, totalCount] = (await db.batch([
    db.all<Found>(sql`
      select t.id as token_id, t.scope as token_scope, t.email as token_email, g.id as grant_id,
        g.scope as grant_scope, g.email as grant_email, g.user_id, a.id as app_id, a.client_id,
        a.max_scope, ${emailAllowed('a')} as email_allowed, a.per_member_per_min,
        a.per_app_per_min, (a.status = 'suspended' or not ${standingOk('dp')}) as cut_off,
        ${usable} as usable, ${appsOn()} as enabled
      from ${held} where ${current}
    `),
    db.all<{ count: number }>(sql`
      insert into action_limits (key, window_start, count)
      select 'appMember.' || a.id || ':' || g.user_id, ${member.start}, 1 from ${held} where ${live}
      on conflict (key, window_start) do update set count = count + 1
      returning count
    `),
    // Only a call within the member's own limit counts toward the app's: otherwise one member,
    // refused for their own flood, would still spend everyone's share and lock the app for all.
    db.all<{ count: number }>(sql`
      insert into action_limits (key, window_start, count)
      select 'appTotal:' || a.id, ${total.start}, 1 from ${held} where ${live}
        and coalesce((select l.count from action_limits l
            where l.key = 'appMember.' || a.id || ':' || g.user_id
              and l.window_start = ${member.start}), 0)
          <= coalesce(a.per_member_per_min, ${APP_DEFAULT_PER_MEMBER_PER_MIN})
      on conflict (key, window_start) do update set count = count + 1
      returning count
    `),
    db.run(sql`
      update app_tokens set pristine = 0,
        last_used_at = case when last_used_at is null or last_used_at <= ${stale} then ${now}
          else last_used_at end
      where id = (select t.id from ${held} where ${live})
        and (pristine = 1 or last_used_at is null or last_used_at <= ${stale})
    `),
    db.run(sql`
      update app_grants set last_used_at = ${now}
      where id = (select g.id from ${held} where ${live})
        and (last_used_at is null or last_used_at <= ${stale})
    `),
  ])) as unknown as [Found[], { count: number }[], { count: number }[], unknown, unknown]
  const row = found[0]
  if (!row) return { ok: false, error: 'invalid_token' }
  if (row.enabled !== 1) return { ok: false, error: 'apps_paused' }
  // A cut-off app is told so, apart from a token that ended: its tokens work again when the
  // operator restores it, or its developer's suspension is lifted (ADR 0067), so it should keep
  // them rather than ask the member to connect again.
  if (row.usable !== 1) {
    return { ok: false, error: row.cut_off === 1 ? 'app_suspended' : 'invalid_token' }
  }
  const over = (count: number | undefined, limit: number) => count === undefined || count > limit
  if (over(memberCount[0]?.count, row.per_member_per_min ?? APP_DEFAULT_PER_MEMBER_PER_MIN)) {
    return { ok: false, error: 'rate_limited', retryAfterSec: secondsUntil(member.end, now) }
  }
  if (over(totalCount[0]?.count, row.per_app_per_min ?? APP_DEFAULT_PER_APP_PER_MIN)) {
    return { ok: false, error: 'rate_limited', retryAfterSec: secondsUntil(total.end, now) }
  }
  return {
    ok: true,
    principal: {
      userId: row.user_id,
      appId: row.app_id,
      clientId: row.client_id,
      grantId: row.grant_id,
      tokenId: row.token_id,
      // The lowest of what this device was given, what the connection holds now (a member who
      // connects again at Read only lowers every device), and the app's ceiling.
      scope: lowerScope(lowerScope(row.token_scope, row.grant_scope), row.max_scope),
      email: row.token_email === 1 && row.grant_email === 1 && row.email_allowed === 1,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Settings → Connected apps

/**
 * A member's live connections (`GET /api/v1/connections`): what each app may do now (the grant,
 * lowered by the app's ceiling and its permission to see the address, `emailAllowed`), and how
 * many devices hold tokens that still work or can still be refreshed.
 */
export async function listConnections(
  db: TelaDb,
  userId: string,
  now: number,
): Promise<Connection[]> {
  const rows = await db.all<{
    id: number
    name: string
    developer: string
    homepage_url: string | null
    client_id: string
    reviewed: number
    developer_handle: string | null
    scope: AppScope
    max_scope: AppScope
    email: number
    email_allowed: number
    created_at: number
    last_used_at: number | null
    devices: number
  }>(sql`
    select g.id, a.name, a.developer, a.homepage_url, a.client_id, (a.reviewed_at is not null) as reviewed,
      (select p.handle from profiles p where p.user_id = a.developer_id) as developer_handle,
      g.scope, a.max_scope, g.email, ${emailAllowed('a')} as email_allowed, g.created_at,
      g.last_used_at,
      (select count(*) from app_tokens t where t.grant_id = g.id and t.ended_at is null
        and (t.access_expires_at > ${now} or t.refresh_idle_expires_at > ${now})) as devices
    from app_grants g join apps a on a.id = g.app_id
    where g.user_id = ${userId} and g.ended_at is null
    order by g.created_at desc, g.id desc
  `)
  return rows.map((r) => ({
    id: r.id,
    app: {
      name: r.name,
      developer: r.developer,
      homepageUrl: r.homepage_url,
      clientId: r.client_id,
      reviewed: r.reviewed === 1,
      developerHandle: r.developer_handle,
    },
    scope: lowerScope(r.scope, r.max_scope),
    email: r.email === 1 && r.email_allowed === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    devices: r.devices,
  }))
}

/**
 * End one of a member's connections and every device's tokens under it, for `reason`: the member
 * disconnecting in Settings. One batch; true when it ended one.
 */
export async function endConnection(
  db: TelaDb,
  input: { userId: string; grantId: number; reason: AppEndReason; now: number },
): Promise<boolean> {
  const { userId, grantId, reason, now } = input
  const [, ended] = (await db.batch([
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = ${reason}
      where ended_at is null and grant_id in (select id from app_grants
        where id = ${grantId} and user_id = ${userId} and ended_at is null)
    `),
    db.all<{ id: number }>(sql`
      update app_grants set ended_at = ${now}, end_reason = ${reason}, updated_at = ${now}
      where id = ${grantId} and user_id = ${userId} and ended_at is null
      returning id
    `),
  ])) as unknown as [unknown, { id: number }[]]
  return ended.length > 0
}
