/**
 * People (ADR 0039): every member's public card and account basics, and signing one out
 * everywhere. Nothing here reads what a member subscribes to, reads, likes, highlights,
 * recommends or follows: the console is for running Tela, not for watching its readers, and a
 * query that never touches those tables cannot leak them.
 */
import { audit, avatarOf, historyOf, type TelaDb } from '@tela/data'
import {
  ADMIN_LIST_LIMIT,
  type AdminInvitedBy,
  type AdminList,
  type AdminPersonDetail,
  type AdminPersonRow,
  isAdminFilter,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import { likePattern } from '../../members'
import { type ActHandler, type AdminEnv, returned, runBatch, searchBody } from '../framework'
import { codeQuery, toCode } from './invites'

/** The ways in besides the mailed code that `account` rows record (ADR 0036). */
const WAYS_IN = sql.raw(`('credential', 'google', 'github')`)

type PersonRaw = {
  user_id: string
  handle: string
  display_name: string | null
  bio: string | null
  email: string
  avatar: string | null
  is_admin: number
  joined_at: number
  sign_in: string
  inv_id: number | null
  inv_code: string | null
  inv_by: string | null
  inv_handle: string | null
  inv_name: string | null
  blogs: number
  invites_used: number
  sessions: number
  last_seen_at: number | null
}

/**
 * A member as the console lists them, over `user u` and `profiles p`. `wall` is the wall clock,
 * which better-auth stamps a session's expiry with, not tela-api's. How they got in is the
 * redemption their account settled, the first if a retry settled two; a member who joined before
 * invitations were recorded has none. An email-code sign-in writes no `account` row, so `sign_in`
 * lists only a password and the providers.
 */
const personSelect = (wall: number) => sql`
  select u.id as user_id, p.handle, p.display_name, p.bio, u.email, ${avatarOf('p')} as avatar,
    p.is_admin, u.created_at as joined_at,
    (select json_group_array(w.provider_id) from (select distinct a.provider_id from account a
      where a.user_id = u.id and a.provider_id in ${WAYS_IN} order by a.provider_id) w) as sign_in,
    r.id as inv_id, r.code as inv_code, c.created_by as inv_by, ip.handle as inv_handle,
    ip.display_name as inv_name,
    (select count(*) from sites s where s.claimed_by = u.id) as blogs,
    (select count(*) from invite_codes mc join invite_redemptions x on x.code = mc.code
      where mc.created_by = u.id and x.redeemed_at is not null) as invites_used,
    (select count(*) from session s where s.user_id = u.id and s.expires_at > ${wall}) as sessions,
    (select max(s.updated_at) from session s where s.user_id = u.id) as last_seen_at
  from user u
  join profiles p on p.user_id = u.id
  left join invite_redemptions r on r.id = (select x.id from invite_redemptions x
    where x.user_id = u.id and x.settled_at is not null order by x.redeemed_at, x.id limit 1)
  left join invite_codes c on c.code = r.code
  left join profiles ip on ip.user_id = c.created_by`

/** A search over a member's handle, display name and address; everyone without one. */
const personMatches = (pattern: string | null): SQL =>
  pattern === null
    ? sql`1`
    : sql`(p.handle like ${pattern} escape '\\' or p.display_name like ${pattern} escape '\\'
        or u.email like ${pattern} escape '\\')`

function invitedBy(r: PersonRaw): AdminInvitedBy | null {
  if (r.inv_id === null) return null
  if (r.inv_code === null) return { kind: 'operator' }
  if (r.inv_by === null) return { kind: 'code', code: r.inv_code }
  return {
    kind: 'member',
    by: r.inv_handle ? { id: r.inv_by, handle: r.inv_handle, name: r.inv_name } : null,
    code: r.inv_code,
  }
}

function parseList(json: string): string[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toPerson(r: PersonRaw): AdminPersonRow {
  return {
    id: r.user_id,
    // Signing out applies while there is a session to end.
    actions: r.sessions > 0 ? ['member.signOut'] : [],
    userId: r.user_id,
    handle: r.handle,
    name: r.display_name,
    email: r.email,
    avatar: r.avatar,
    isAdmin: r.is_admin === 1,
    signIn: parseList(r.sign_in),
    joinedAt: r.joined_at,
    invitedBy: invitedBy(r),
    blogs: r.blogs,
    invitesUsed: r.invites_used,
    sessions: r.sessions,
    lastSeenAt: r.last_seen_at,
  }
}

/**
 * Sign a member out on every device: `endOtherSessions` with nothing kept, in a batch with its
 * audit row, which counts the sessions it ends. Each device's signed five-minute copy of its
 * session still works where only that copy is read (ADR 0024); `/api/v1/account` and the console's
 * door read past it. No undo: a session ended cannot be given back.
 */
const signOut: ActHandler = async (ctx, id) => {
  const { db } = ctx.deps
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'member.signOut',
        targetKind: 'member',
        targetKey: id,
        at: ctx.now,
      },
      {
        from: sql`json_object('sessions', (select count(*) from session s where s.user_id = ${id}))`,
        to: { sessions: 0 },
      },
      sql`from user where id = ${id} and exists (select 1 from session s where s.user_id = ${id})`,
    ),
    db.all(sql`delete from session where user_id = ${id} returning id`),
    db.all(sql`select id from user where id = ${id}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/**
 * `GET /people?f=` and `GET /people/:id`; a search is `POST /people {f, q}`. A search here is often
 * an email address, and a request's URL reaches the Workers' logs where its body does not.
 */
export function peopleRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()

  const list = async (f: string, q: string) => {
    if (!isAdminFilter('people', f)) return null
    const matches = personMatches(likePattern(q))
    const [counts, rows] = await db.batch([
      db.all<{ admins: number; members: number }>(sql`
        select coalesce(sum(p.is_admin = 1), 0) as admins, coalesce(sum(p.is_admin <> 1), 0) as members
        from user u join profiles p on p.user_id = u.id where ${matches}
      `),
      db.all<PersonRaw>(sql`
        ${personSelect(deps.clock.now())}
        where p.is_admin = ${f === 'admins' ? 1 : 0} and ${matches}
        order by u.created_at desc, u.id limit ${ADMIN_LIST_LIMIT + 1}
      `),
    ])
    const answer: AdminList<AdminPersonRow, 'people'> = {
      counts: { admins: counts[0]?.admins ?? 0, members: counts[0]?.members ?? 0 },
      rows: rows.slice(0, ADMIN_LIST_LIMIT).map(toPerson),
      truncated: rows.length > ADMIN_LIST_LIMIT,
    }
    return answer
  }

  routes.get('/people', async (c) => {
    const answer = await list(c.req.query('f') ?? 'admins', '')
    return answer ? c.json(answer) : c.json({ error: 'invalid' }, 400)
  })
  routes.post('/people', async (c) => {
    const body = await searchBody(c.req.raw)
    const answer = body && (await list(body.f ?? 'admins', body.q))
    return answer ? c.json(answer) : c.json({ error: 'invalid' }, 400)
  })

  routes.get('/people/:id', async (c) => {
    const detail = await personDetail(db, c.req.param('id'), deps.clock.now())
    return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
  })

  return routes
}

/**
 * One member's record: their card, the blogs they claim, every code they made (revoked ones too,
 * with who joined by each), and what operators did to their account.
 */
async function personDetail(
  db: TelaDb,
  userId: string,
  now: number,
): Promise<AdminPersonDetail | null> {
  const [people, blogs, codes] = await db.batch([
    db.all<PersonRaw>(sql`${personSelect(Date.now())} where u.id = ${userId}`),
    db.all<{
      site_id: number
      title: string | null
      home_url: string
      listing: string
      reader_count: number
    }>(sql`
      select s.id as site_id, s.title, s.home_url, s.listing, s.reader_count from sites s
      where s.claimed_by = ${userId} order by s.claimed_at desc, s.id
    `),
    codeQuery(db, sql`c.created_by = ${userId}`, now, sql`c.created_at, c.code`),
  ])
  const person = people[0]
  if (!person) return null
  return {
    person: toPerson(person),
    bio: person.bio,
    blogs: blogs.map((b) => ({
      siteId: b.site_id,
      title: b.title,
      homeUrl: b.home_url,
      listing: b.listing,
      readerCount: b.reader_count,
    })),
    codes: codes.map(toCode),
    history: await historyOf(db, 'member', userId),
  }
}

export const peopleActions = { 'member.signOut': signOut }
