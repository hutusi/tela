import { RECOMMENDATION_NOTE_MAX } from '@tela/shared'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, feeds, profiles, recommendations, sites, subscriptions } from '../schema'

/** Handles a member cannot take because they collide with routes or brand. */
const RESERVED_HANDLES = new Set([
  'admin',
  'tela',
  'settings',
  'dashboard',
  'login',
  'logout',
  'api',
  'reading',
  'discover',
  'add',
  'claim',
  'sites',
  's',
  'img',
  'u',
  'auth',
  'about',
  'help',
  'support',
  'me',
  'profile',
])
const HANDLE_RE = /^[a-z0-9_]{3,30}$/

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle) && !RESERVED_HANDLES.has(handle)
}

export type Recommendation = { id: number; note: string | null; createdAt: Date }

export async function getRecommendation(
  db: Db,
  userId: string,
  articleId: number,
): Promise<Recommendation | null> {
  const [row] = await db
    .select({
      id: recommendations.id,
      note: recommendations.note,
      createdAt: recommendations.createdAt,
    })
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), eq(recommendations.articleId, articleId)))
  return row ?? null
}

/** Recommend an article (or update the note); keeps articles.recommend_count in step. */
export async function recommend(
  db: Db,
  userId: string,
  articleId: number,
  note: string | null,
): Promise<{ recommendCount: number; created: boolean }> {
  const trimmed = note?.trim().slice(0, RECOMMENDATION_NOTE_MAX) || null
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.articleId, articleId)))
      .for('update')
    if (existing) {
      await tx
        .update(recommendations)
        .set({ note: trimmed })
        .where(eq(recommendations.id, existing.id))
    } else {
      await tx.insert(recommendations).values({ userId, articleId, note: trimmed })
      await tx
        .update(articles)
        .set({ recommendCount: sql`${articles.recommendCount} + 1` })
        .where(eq(articles.id, articleId))
    }
    const [row] = await tx
      .select({ recommendCount: articles.recommendCount })
      .from(articles)
      .where(eq(articles.id, articleId))
    return { recommendCount: row?.recommendCount ?? 0, created: existing === undefined }
  })
}

export async function unrecommend(
  db: Db,
  userId: string,
  articleId: number,
): Promise<{ recommendCount: number }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.articleId, articleId)))
      .returning({ id: recommendations.id })
    if (deleted.length > 0) {
      await tx
        .update(articles)
        .set({ recommendCount: sql`greatest(0, ${articles.recommendCount} - 1)` })
        .where(eq(articles.id, articleId))
    }
    const [row] = await tx
      .select({ recommendCount: articles.recommendCount })
      .from(articles)
      .where(eq(articles.id, articleId))
    return { recommendCount: row?.recommendCount ?? 0 }
  })
}

export type PublicProfile = {
  profile: {
    id: string
    handle: string
    displayName: string | null
    bio: string | null
    createdAt: Date
  }
  recommendations: Array<{
    id: number
    note: string | null
    createdAt: Date
    article: { id: number; title: string; url: string | null; sourceLang: string | null }
    site: { id: number; title: string | null; homeUrl: string }
  }>
  /** Null when the member keeps subscriptions private. */
  subscriptions: Array<{
    siteId: number
    feedId: number
    title: string
    homeUrl: string
    faviconKey: string | null
  }> | null
  claimedSites: Array<{
    id: number
    title: string | null
    homeUrl: string
    faviconKey: string | null
  }>
}

export async function getPublicProfile(db: Db, handle: string): Promise<PublicProfile | null> {
  const [p] = await db.select().from(profiles).where(eq(profiles.handle, handle.toLowerCase()))
  if (!p) return null
  const recs = await db
    .select({
      id: recommendations.id,
      note: recommendations.note,
      createdAt: recommendations.createdAt,
      articleId: articles.id,
      title: articles.title,
      url: articles.url,
      sourceLang: articles.sourceLang,
      siteId: sites.id,
      siteTitle: sites.title,
      homeUrl: sites.homeUrl,
    })
    .from(recommendations)
    .innerJoin(articles, eq(articles.id, recommendations.articleId))
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .where(eq(recommendations.userId, p.id))
    .orderBy(desc(recommendations.createdAt))
    .limit(100)
  let subs: PublicProfile['subscriptions'] = null
  if (p.publicSubscriptions) {
    const rows = await db
      .select({
        siteId: sites.id,
        feedId: feeds.id,
        feedTitle: feeds.title,
        siteTitle: sites.title,
        homeUrl: sites.homeUrl,
        faviconKey: sites.faviconKey,
      })
      .from(subscriptions)
      .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
      .innerJoin(sites, eq(sites.id, feeds.siteId))
      .where(eq(subscriptions.userId, p.id))
      .orderBy(sql`lower(coalesce(${feeds.title}, ${sites.title}, ${sites.homeUrl}))`)
    subs = rows.map((r) => ({
      siteId: r.siteId,
      feedId: r.feedId,
      title: r.feedTitle ?? r.siteTitle ?? r.homeUrl,
      homeUrl: r.homeUrl,
      faviconKey: r.faviconKey,
    }))
  }
  const claimed = await db
    .select({
      id: sites.id,
      title: sites.title,
      homeUrl: sites.homeUrl,
      faviconKey: sites.faviconKey,
    })
    .from(sites)
    .where(eq(sites.claimedBy, p.id))
    .orderBy(sites.id)
  return {
    profile: {
      id: p.id,
      handle: p.handle,
      displayName: p.displayName,
      bio: p.bio,
      createdAt: p.createdAt,
    },
    recommendations: recs.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt,
      article: { id: r.articleId, title: r.title, url: r.url, sourceLang: r.sourceLang },
      site: { id: r.siteId, title: r.siteTitle, homeUrl: r.homeUrl },
    })),
    subscriptions: subs,
    claimedSites: claimed,
  }
}

export type ProfilePatch = {
  handle?: string
  displayName?: string | null
  bio?: string | null
  publicSubscriptions?: boolean
}

export type ProfileUpdateResult = 'ok' | 'invalid_handle' | 'handle_taken'

export async function updateProfile(
  db: Db,
  userId: string,
  patch: ProfilePatch,
): Promise<ProfileUpdateResult> {
  const set: Partial<typeof profiles.$inferInsert> = {}
  if (patch.handle !== undefined) {
    const handle = patch.handle.trim().toLowerCase()
    if (!isValidHandle(handle)) return 'invalid_handle'
    set.handle = handle
  }
  if (patch.displayName !== undefined)
    set.displayName = patch.displayName?.trim().slice(0, 80) || null
  if (patch.bio !== undefined) set.bio = patch.bio?.trim().slice(0, 280) || null
  if (patch.publicSubscriptions !== undefined) set.publicSubscriptions = patch.publicSubscriptions
  if (Object.keys(set).length === 0) return 'ok'
  try {
    await db.update(profiles).set(set).where(eq(profiles.id, userId))
    return 'ok'
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string; code?: string } }).cause
    if (cause?.code === '23505' || cause?.constraint_name === 'profiles_handle_key')
      return 'handle_taken'
    throw err
  }
}

export type Dashboard = {
  sites: Array<{
    id: number
    title: string | null
    homeUrl: string
    faviconKey: string | null
    listing: string
    readerCount: number
    translationOptOut: boolean
    posts: Array<{
      id: number
      title: string
      publishedAt: Date | null
      likeCount: number
      recommendCount: number
    }>
  }>
  notes: Array<{
    id: number
    note: string | null
    createdAt: Date
    article: { id: number; title: string }
    site: { id: number; title: string | null }
    recommender: { handle: string; displayName: string | null }
  }>
}

/** What an author sees: their claimed sites, per-post likes and recommendations, and notes. */
export async function getDashboard(db: Db, userId: string): Promise<Dashboard> {
  const owned = await db
    .select()
    .from(sites)
    .where(eq(sites.claimedBy, userId))
    .orderBy(desc(sites.readerCount), sites.id)
  if (owned.length === 0) return { sites: [], notes: [] }
  const siteIds = owned.map((s) => s.id)
  const posts = await db
    .select({
      siteId: feeds.siteId,
      id: articles.id,
      title: articles.title,
      publishedAt: articles.publishedAt,
      likeCount: articles.likeCount,
      recommendCount: articles.recommendCount,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(inArray(feeds.siteId, siteIds))
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`), desc(articles.id))
    .limit(200)
  const notes = await db
    .select({
      id: recommendations.id,
      note: recommendations.note,
      createdAt: recommendations.createdAt,
      articleId: articles.id,
      articleTitle: articles.title,
      siteId: sites.id,
      siteTitle: sites.title,
      handle: profiles.handle,
      displayName: profiles.displayName,
    })
    .from(recommendations)
    .innerJoin(articles, eq(articles.id, recommendations.articleId))
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .innerJoin(profiles, eq(profiles.id, recommendations.userId))
    .where(and(inArray(sites.id, siteIds), isNotNull(recommendations.note)))
    .orderBy(desc(recommendations.createdAt))
    .limit(50)
  return {
    sites: owned.map((s) => ({
      id: s.id,
      title: s.title,
      homeUrl: s.homeUrl,
      faviconKey: s.faviconKey,
      listing: s.listing,
      readerCount: s.readerCount,
      translationOptOut: s.translationOptOut,
      posts: posts
        .filter((p) => p.siteId === s.id)
        .slice(0, 20)
        .map(({ siteId: _s, ...p }) => p),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      note: n.note,
      createdAt: n.createdAt,
      article: { id: n.articleId, title: n.articleTitle },
      site: { id: n.siteId, title: n.siteTitle },
      recommender: { handle: n.handle, displayName: n.displayName },
    })),
  }
}

export async function setTranslationOptOut(
  db: Db,
  siteId: number,
  userId: string,
  optOut: boolean,
): Promise<boolean> {
  const rows = await db
    .update(sites)
    .set({ translationOptOut: optOut })
    .where(and(eq(sites.id, siteId), eq(sites.claimedBy, userId)))
    .returning({ id: sites.id })
  return rows.length > 0
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The member's subscriptions as OPML 2.0. */
export async function exportSubscriptionsOpml(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({
      feedUrl: feeds.feedUrl,
      feedTitle: feeds.title,
      siteTitle: sites.title,
      homeUrl: sites.homeUrl,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .where(eq(subscriptions.userId, userId))
    .orderBy(sql`lower(coalesce(${feeds.title}, ${sites.title}, ${sites.homeUrl}))`)
  const outlines = rows
    .map((r) => {
      const text = xml(r.feedTitle ?? r.siteTitle ?? r.homeUrl)
      return `    <outline type="rss" text="${text}" title="${text}" xmlUrl="${xml(r.feedUrl)}" htmlUrl="${xml(r.homeUrl)}"/>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Tela subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>
`
}
