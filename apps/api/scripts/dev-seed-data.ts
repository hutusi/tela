/**
 * What `bun run dev:seed` writes into a local database: the states an operator acts on in the
 * admin console (ADR 0039), which a handful of healthy blogs fetched in dev never reach. Members
 * and the way each came in, codes and holds, claims to review, feeds in trouble, a month of
 * translation spend, work that gave up, the runs' heartbeats, and what operators did. Pure, so
 * `test/dev-seed.test.ts` holds it to the schema: a migration that renames a column it writes
 * fails there, not on someone's laptop.
 *
 * Never production data: every member is made up, every address is on a reserved domain or a
 * documentation range, and the runner only ever writes with `wrangler d1 execute --local`.
 */

export type SeedSite = { id: number; homeUrl: string; feedId: number }

export type SeedInput = {
  now: number
  /** The blogs already there, in id order: the seed gives them owners, listings and trouble. */
  sites: readonly SeedSite[]
  /**
   * The admin the history names and the verified claim belongs to: the member `dev:seed <email>`
   * granted, or the seed's own Mara, who is then made an admin.
   */
  actor: string | null
}

/** The seed's own members are `seed_*`: the runner checks for one to seed only once. */
export const SEED_MARKER = 'seed_mara'

/** The fewest blogs the seed spreads its states over. */
export const SEED_MIN_SITES = 24

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** A small deterministic generator (mulberry32): the same seed every run. */
function random(seed: number) {
  let a = seed
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const q = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return String(Math.round(v))
  return `'${v.replaceAll("'", "''")}'`
}

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type Member = {
  id: string
  handle: string
  name: string | null
  email: string
  joinedDays: number
  bio: string
  ways: readonly ('credential' | 'google' | 'github')[]
}

const MEMBERS: readonly Member[] = [
  {
    id: 'seed_mara',
    handle: 'mara',
    name: 'Mara Lindqvist',
    email: 'mara@example.se',
    joinedDays: 34,
    bio: 'Editor in Stockholm. I read slow blogs in four languages, two of them badly.',
    ways: ['google'],
  },
  {
    id: 'seed_ana',
    handle: 'ana',
    name: 'Ana Ribeiro',
    email: 'ana.ribeiro@example.com',
    joinedDays: 31,
    bio: 'Translator in Porto. Reads mostly in Portuguese and Spanish.',
    ways: ['github'],
  },
  {
    id: 'seed_lucia',
    handle: 'lucia',
    name: 'Lucía Ferrer',
    email: 'lucia.ferrer@example.es',
    joinedDays: 27,
    bio: 'Walks a different Madrid street each week and writes down what she finds.',
    ways: ['credential'],
  },
  {
    id: 'seed_megumi',
    handle: 'megumi',
    name: 'Megumi Sato',
    email: 'megumi.sato@example.jp',
    joinedDays: 25,
    bio: 'Writes about weather, neighbours and what the boats bring in.',
    ways: ['google'],
  },
  {
    id: 'seed_jiwoo',
    handle: 'jiwoo',
    name: 'Kim Ji-woo',
    email: 'jiwoo.kim@example.kr',
    joinedDays: 3,
    bio: 'Cooks, ferments and writes it down, from Seoul.',
    ways: [],
  },
  {
    id: 'seed_priya',
    handle: 'priya',
    name: 'Priya Nair',
    email: 'priya@example.in',
    joinedDays: 21,
    bio: 'Making rented flats feel like your own, without losing the deposit.',
    ways: [],
  },
  {
    id: 'seed_growth',
    handle: 'growthhacker',
    name: null,
    email: 'gh.course@example.org',
    joinedDays: 4,
    bio: '10x your newsletter in 30 days. Course link below.',
    ways: [],
  },
  {
    id: 'seed_sam',
    handle: 'sam',
    name: 'Sam Okafor',
    email: 'sam@example.net',
    joinedDays: 10,
    bio: 'Type design history, one specimen at a time.',
    ways: ['credential', 'github'],
  },
]

/** The statements, in order, each one complete; the runner applies them as one file. */
export function seedStatements({ now, sites, actor }: SeedInput): string[] {
  if (sites.length < SEED_MIN_SITES) {
    throw new Error(`the seed needs at least ${SEED_MIN_SITES} blogs, found ${sites.length}`)
  }
  const rand = random(39)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const site = (i: number) => sites[i % sites.length] as SeedSite
  const owner = actor ?? 'seed_mara'
  const out: string[] = []
  const add = (s: string) => out.push(`${s.trim().replace(/;$/, '')};`)
  const SEQ = `(select v from counters where k = 'seq')`

  add(`insert into counters (k, v) values ('seq', 1) on conflict (k) do update set v = v + 1`)

  // Members, their ways in, and the devices they are signed in on.
  for (const m of MEMBERS) {
    const at = now - m.joinedDays * DAY - between(0, 6) * HOUR
    add(`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${q(m.id)}, ${q(m.name ?? '')}, ${q(m.email)}, 1, ${at}, ${at})`)
    add(`insert into profiles (user_id, handle, display_name, bio, is_admin, created_at, updated_at,
        seq) values (${q(m.id)}, ${q(m.handle)}, ${q(m.name)}, ${q(m.bio)},
        ${q(actor === null && m.id === 'seed_mara')}, ${at}, ${at}, ${SEQ})`)
    m.ways.forEach((provider, i) => {
      add(`insert into account (id, account_id, provider_id, user_id, password, created_at,
          updated_at) values (${q(`acc_${m.id}_${i}`)}, ${q(`${provider}-${m.handle}`)},
          ${q(provider)}, ${q(m.id)}, ${q(provider === 'credential' ? 'seeded' : null)}, ${at}, ${at})`)
    })
    for (let s = 0; s < between(0, 3); s++) {
      const seen = now - between(1, 72) * HOUR
      add(`insert into session (id, expires_at, token, created_at, updated_at, ip_address,
          user_agent, user_id) values (${q(`ses_${m.id}_${s}`)}, ${now + 20 * DAY},
          ${q(`tok_${m.id}_${s}`)}, ${seen - DAY}, ${seen}, '203.0.113.9', 'Mozilla/5.0',
          ${q(m.id)})`)
    }
  }

  // The operator's codes and members' codes, who joined with which, and who is still waiting.
  const codes: [string, string | null, number, number, number | null][] = [
    ['WELCOME2026', null, 50, 36, null],
    ['WRITERS2026', null, 100, 22, null],
    ['BETA', null, 25, 40, 20],
    ['K7M2Q9X4P3RT', 'seed_mara', 1, 26, null],
    ['H8N3W5Y2C6DF', 'seed_mara', 1, 26, null],
    ['Q4R7T2M9X3VB', 'seed_megumi', 1, 5, null],
    ['Z5P8K3N7W2HG', 'seed_priya', 1, 6, null],
    ['B3C6F9J2M5QS', 'seed_priya', 1, 6, 2],
  ]
  for (const [code, by, uses, days, revoked] of codes) {
    add(`insert into invite_codes (code, created_by, max_uses, created_at, revoked_at)
      values (${q(code)}, ${q(by)}, ${uses}, ${now - days * DAY},
      ${q(revoked === null ? null : now - revoked * DAY)})`)
  }
  const joinedWith: [string, string | null][] = [
    ['seed_mara', 'WELCOME2026'],
    ['seed_ana', null],
    ['seed_lucia', 'WELCOME2026'],
    ['seed_megumi', 'K7M2Q9X4P3RT'],
    ['seed_jiwoo', 'Q4R7T2M9X3VB'],
    ['seed_priya', 'WRITERS2026'],
    ['seed_growth', 'Z5P8K3N7W2HG'],
    ['seed_sam', 'WRITERS2026'],
  ]
  for (const [id, code] of joinedWith) {
    const m = MEMBERS.find((x) => x.id === id) as Member
    const at = now - m.joinedDays * DAY
    add(`insert into invite_redemptions (code, email, expires_at, redeemed_at, user_id,
        settled_at, created_at) values (${q(code)}, ${q(m.email)}, ${at + DAY}, ${at}, ${q(id)},
        ${at}, ${at - HOUR})`)
  }
  for (const [code, email, hours] of [
    ['WRITERS2026', 'jonas@example.no', 2],
    ['H8N3W5Y2C6DF', 'h.tanaka@example.jp', 5],
    ['WRITERS2026', 'course-buyer-17@example.org', 1],
  ] as const) {
    add(`insert into invite_redemptions (code, email, expires_at, created_at)
      values (${q(code)}, ${q(email)}, ${now + (24 - hours) * HOUR}, ${now - hours * HOUR})`)
  }

  // Readers, listings, a hidden blog and one whose author asked for no translation.
  for (const s of sites) {
    add(`update sites set reader_count = ${pick([1, 3, 5, 8, 12, 21, 40, 96])} where id = ${s.id}`)
  }
  for (const i of [1, 2, 4, 7]) {
    add(`update sites set listing = 'listed', seq = ${SEQ} where id = ${site(i).id}`)
  }
  for (const [i, readers] of [
    [16, 2],
    [17, 1],
    [18, 2],
  ] as const) {
    add(`update sites set listing = 'private', reader_count = ${readers}, claimed_by = null,
        seq = ${SEQ} where id = ${site(i).id}`)
  }
  add(`update sites set listing = 'rejected', seq = ${SEQ} where id = ${site(22).id}`)
  add(`update sites set translation_opt_out = 1, seq = ${SEQ} where id = ${site(21).id}`)

  // Claims: verified ones, three for review (a page that answered 403, a tag in the wrong place,
  // a dispute), one still checking and backing off, and one an operator already dismissed.
  const owned =
    sites.findIndex((s) => s.homeUrl.includes('hutusi.com')) >= 0
      ? sites.findIndex((s) => s.homeUrl.includes('hutusi.com'))
      : 23
  const claims: [number, string, string, string, string | null, number, number | null][] = [
    [owned, owner, 'meta', 'verified', null, 30, null],
    [12, 'seed_sam', 'rel_me', 'verified', null, 9, null],
    [9, 'seed_mara', 'meta', 'verified', null, 20, null],
    [11, 'seed_lucia', 'meta', 'failed', 'the home page answered 403 (bot protection)', 1, null],
    [
      14,
      'seed_priya',
      'meta',
      'failed',
      'found the tela-site-verification tag inside <body>; it must be in <head>',
      2,
      null,
    ],
    [9, 'seed_growth', 'meta', 'failed', 'this blog is claimed by another member', 1, null],
    [8, 'seed_jiwoo', 'rel_me', 'pending', null, 0, null],
    [15, 'seed_ana', 'meta', 'failed', 'no meta tag with the token on the home page', 6, 5],
  ]
  claims.forEach(([i, member, method, status, error, days, reviewed], n) => {
    const at = now - days * DAY - 2 * HOUR
    const checked = at + 10 * MIN
    const id = 9001 + n
    add(`insert into site_claims (id, site_id, user_id, method, token, status, last_checked_at,
        error, verified_at, created_at, reviewed_at, seq) values (${id}, ${site(i).id},
        ${q(member)}, ${q(method)}, ${q(`seedtoken${n}abcdef0123`)}, ${q(status)}, ${checked},
        ${q(error)}, ${q(status === 'verified' ? checked : null)}, ${at},
        ${q(reviewed === null ? null : now - reviewed * DAY)}, ${SEQ})
        on conflict (site_id, user_id) do nothing`)
    if (status === 'verified') {
      add(`update sites set claimed_by = ${q(member)}, claimed_at = ${checked}, seq = ${SEQ}
          where id = ${site(i).id}`)
    }
    if (status === 'pending') {
      add(`insert into leases (kind, key, owner, until, attempts, not_before, last_error, host)
          values ('site.claim', ${q(String(id))}, 'seed', 0, 2, ${now + 25 * MIN},
          'timeout: the home page did not answer in 15 s', ${q(host(site(i).homeUrl))})`)
    }
  })

  // Feeds in trouble: failing, timing out, dead, paused by an operator, and merged into another.
  const later = now + 6 * HOUR
  const feeds: [number, string, number, number, string | null][] = [
    [6, 'active', 4, 0, 'http: 404 Not Found'],
    [20, 'active', 2, 0, 'parse: unescaped "&" at line 212, column 31'],
    [21, 'active', 3, 0, 'tls: certificate has expired'],
    [25, 'active', 6, 6, 'timeout: no response after 15 s'],
    [33, 'active', 3, 3, 'timeout: no response after 15 s'],
    [19, 'dead', 30, 0, 'dns: getaddrinfo ENOTFOUND'],
    [13, 'paused', 0, 0, null],
  ]
  for (const [i, status, errors, streak, error] of feeds) {
    add(`update feeds set status = ${q(status)}, error_count = ${errors},
        timeout_streak = ${streak}, last_error = ${q(error)}, next_fetch_at = ${later},
        last_fetched_at = ${now - 2 * HOUR}, seq = ${SEQ} where id = ${site(i).feedId}`)
  }
  const merged = site(23)
  add(`insert into feeds (site_id, feed_url, host, next_fetch_at, created_at, updated_at, status,
      merged_into, title, seq) values (${merged.id}, ${q(`http://feeds.example.com/${host(merged.homeUrl)}`)},
      'feeds.example.com', ${later}, ${now - 12 * DAY}, ${now - 12 * DAY}, 'paused',
      ${merged.feedId}, 'FeedBurner copy', ${SEQ})`)

  // A month of translation spend, today's background budget, and a member near their cap.
  const spenders = [0, 1, 11, 23, 24, 25, 26, 29, 30, 32, 33, 34].map((i) => site(i).feedId)
  for (let day = 1; day < 30; day++) {
    for (let n = between(4, 10); n > 0; n--) {
      const job = pick(['translate.title', 'translate.title', 'translate.title', 'translate.body'])
      const input = job === 'translate.title' ? between(800, 6000) : between(6000, 30000)
      add(`insert into llm_calls (job, feed_id, target_lang, user_id, model, input_tokens,
          output_tokens, latency_ms, created_at) values (${q(job)}, ${pick(spenders)},
          ${q(pick(['en', 'zh-Hans', 'fr', 'en', 'zh-Hans']))},
          ${q(job === 'translate.body' && rand() < 0.4 ? 'seed_lucia' : null)},
          ${q(pick(['bailian/glm-5.2', 'bailian/glm-5.2', 'bailian/qwen-max']))}, ${input},
          ${Math.round(input * (0.8 + rand() * 0.5))}, ${between(700, 9000)},
          ${now - day * DAY + between(0, 20) * HOUR})`)
    }
  }
  const today = new Date(now).toISOString().slice(0, 10)
  add(`insert into usage_daily (subject, day, reserved, used) values ('*', ${q(today)}, 0, 612000)
      on conflict (subject, day) do update set used = usage_daily.used + 612000`)
  add(`insert into usage_daily (subject, day, reserved, used)
      values ('seed_lucia', ${q(today)}, 40000, 352000) on conflict (subject, day) do nothing`)

  // Work that gave up, and work backing off.
  const extracted = `(select min(id) from articles where feed_id = ${site(11).feedId})`
  const body = `(select content_key from articles where feed_id = ${site(23).feedId}
    and content_key is not null order by id limit 1)`
  add(`update articles set extract_state = 'failed' where id = ${extracted}`)
  add(`insert into body_translations (content_key, lang, state, requested_by, reserved_tokens,
      reserved_day, updated_at, seq)
      select ${body}, 'fr', 'failed', 'seed_lucia', 0, ${q(today)}, ${now - 3 * HOUR}, ${SEQ}
      where ${body} is not null
      on conflict (content_key, lang) do nothing`)
  const dead: [string, string, number, string, number][] = [
    [
      'article.extract',
      `cast(${extracted} as text)`,
      4,
      'readability: no candidate above the score threshold',
      2,
    ],
    ['translate.body', `${body} || ':fr'`, 3, '529 Overloaded after 30.0 s', 3],
    ['site.assets', q(String(site(19).id)), 3, 'favicon: 404 Not Found', 8],
    ['member.gravatar', q('seed_sam'), 3, '429 Too Many Requests', 11],
    ['feed.fetch', q(String(site(19).feedId)), 5, 'died or overran its lease', 5],
  ]
  for (const [kind, key, attempts, error, hours] of dead) {
    add(`insert into dead_letters (kind, key, attempts, error, at)
        select ${q(kind)}, ${key}, ${attempts}, ${q(error)}, ${now - hours * HOUR}
        where ${key} is not null`)
  }
  add(`insert into dead_letters (kind, key, attempts, error, at, resolved_at, resolution,
      resolved_by) values ('feed.fetch', ${q(String(site(16).feedId))}, 5, 'HTTP 503',
      ${now - 3 * DAY}, ${now - 2 * DAY}, 'retried', ${q(owner)}),
      ('site.assets', ${q(String(site(17).id))}, 3, 'favicon: not an image', ${now - 4 * DAY},
      ${now - 4 * DAY + HOUR}, 'dismissed', ${q(owner)})`)
  add(`insert into leases (kind, key, owner, until, attempts, not_before, last_error, host) values
      ('feed.fetch', ${q(String(site(6).feedId))}, 'seed', 0, 2, ${now + 18 * MIN}, 'HTTP 503',
        ${q(host(site(6).homeUrl))}),
      ('translate.title', ${q(String(site(25).feedId))}, 'seed', 0, 1, ${now + 9 * MIN},
        '529 Overloaded', null)
      on conflict (kind, key) do nothing`)

  // The runs' heartbeats (the tick writes its own), and what operators did.
  const beat = (name: string, at: number, info: unknown) =>
    add(`insert into ops_heartbeats (name, at, info) values (${q(name)}, ${at},
        ${q(JSON.stringify(info))}) on conflict (name) do update set at = excluded.at,
        info = excluded.info`)
  const lastDaily = now - ((now - (3 * HOUR + 17 * MIN)) % DAY)
  beat('daily', lastDaily + 41_000, {
    revived: 1,
    backup: { date: new Date(lastDaily).toISOString().slice(0, 10), rows: 9412, verified: true },
  })
  beat('digest', now - 2 * DAY, { sent: true, subject: 'Tela this week' })
  beat('health', now - 2 * MIN, { ok: true, problems: [] })
  const history: [number, string, string, string, unknown, unknown][] = [
    [
      9,
      'site.feature',
      'site',
      String(site(12).id),
      { listing: 'listed' },
      { listing: 'featured' },
    ],
    [8, 'site.hide', 'site', String(site(22).id), { listing: 'featured' }, { listing: 'rejected' }],
    [6, 'claim.dismiss', 'claim', '9008', { reviewedAt: null }, { reviewedAt: now - 5 * DAY }],
    [5, 'feed.pause', 'feed', String(site(13).feedId), { status: 'active' }, { status: 'paused' }],
    [2, 'code.create', 'code', 'WRITERS2026', null, { maxUses: 100 }],
    [
      1,
      'site.translationOff',
      'site',
      String(site(21).id),
      { translationOptOut: 0 },
      { translationOptOut: 1 },
    ],
  ]
  history.forEach(([days, action, kind, key, from, to], i) => {
    add(`insert into admin_actions (group_id, actor_id, action, target_kind, target_key, detail,
        at) values (${q(`seed-group-${i}`)}, ${q(owner)}, ${q(action)}, ${q(kind)}, ${q(key)},
        ${q(JSON.stringify({ from, to }))}, ${now - days * DAY - i * HOUR})`)
  })
  return out
}
