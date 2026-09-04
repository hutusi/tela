import { absoluteUrl } from '@tela/content'
import { type Db, sites } from '@tela/db'
import { type HttpClient, HttpError } from '@tela/ingest'
import { findAll, getAttributeValue } from 'domutils'
import { eq } from 'drizzle-orm'
import { parseDocument } from 'htmlparser2'
import type { AssetStore } from './store'

export type AssetDeps = { db: Db; http: HttpClient; store: AssetStore | null }

export type AssetsOutcome = {
  status: 'done' | 'skipped'
  favicon: boolean
  cover: boolean
  reason?: string
}

const MAX_ICON_BYTES = 1024 * 1024
const MAX_COVER_BYTES = 8 * 1024 * 1024

/** Candidate icon URLs from a page, best first (largest declared size, then apple-touch, then any). */
export function findIconUrls(html: string, baseUrl: string): string[] {
  const doc = parseDocument(html)
  const scored: Array<{ url: string; score: number }> = []
  for (const link of findAll((el) => el.name === 'link', doc.children)) {
    const rel = (getAttributeValue(link, 'rel') ?? '').toLowerCase().split(/\s+/)
    if (
      !rel.some(
        (r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed',
      )
    )
      continue
    const url = absoluteUrl(getAttributeValue(link, 'href') ?? '', baseUrl)
    if (!url) continue
    const sizes = getAttributeValue(link, 'sizes') ?? ''
    const px = Number(sizes.match(/(\d+)x/i)?.[1] ?? 0)
    const apple = rel.some((r) => r.startsWith('apple')) ? 1000 : 0
    scored.push({ url, score: (px >= 32 && px <= 512 ? px : 0) + apple })
  }
  scored.sort((a, b) => b.score - a.score)
  const urls = [...new Set(scored.map((s) => s.url))]
  const fallback = absoluteUrl('/favicon.ico', baseUrl)
  if (fallback && !urls.includes(fallback)) urls.push(fallback)
  return urls
}

/** og:image / twitter:image, absolute. */
export function findCoverUrl(html: string, baseUrl: string): string | null {
  const doc = parseDocument(html)
  for (const meta of findAll((el) => el.name === 'meta', doc.children)) {
    const key = (
      getAttributeValue(meta, 'property') ??
      getAttributeValue(meta, 'name') ??
      ''
    ).toLowerCase()
    if (key === 'og:image' || key === 'og:image:url' || key === 'twitter:image') {
      const url = absoluteUrl(getAttributeValue(meta, 'content') ?? '', baseUrl)
      if (url) return url
    }
  }
  return null
}

async function fetchBytes(
  http: HttpClient,
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await http.get(url, { accept: 'image/*,*/*;q=0.5' })
    if (res.status !== 200 || res.bytes === 0 || res.bytes > maxBytes) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    return { bytes: res.raw, type }
  } catch (err) {
    if (err instanceof HttpError) return null
    throw err
  }
}

async function normalizeIcon(
  bytes: Uint8Array,
  type: string,
): Promise<{ bytes: Uint8Array; type: string; ext: string }> {
  if (type === 'image/x-icon' || type === 'image/vnd.microsoft.icon' || type === 'image/svg+xml') {
    return {
      bytes,
      type: type === 'image/svg+xml' ? 'image/svg+xml' : 'image/x-icon',
      ext: type === 'image/svg+xml' ? 'svg' : 'ico',
    }
  }
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(bytes).resize(64, 64, { fit: 'cover' }).png().toBuffer()
    return { bytes: new Uint8Array(out), type: 'image/png', ext: 'png' }
  } catch {
    return { bytes, type: type || 'application/octet-stream', ext: 'img' }
  }
}

async function normalizeCover(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; type: string; ext: string } | null> {
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(bytes)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
    return { bytes: new Uint8Array(out), type: 'image/webp', ext: 'webp' }
  } catch {
    return null
  }
}

/** Find, normalize, and store a site's favicon and cover; always stamps assets_checked_at. */
export async function processSiteAssets(deps: AssetDeps, siteId: number): Promise<AssetsOutcome> {
  const [site] = await deps.db.select().from(sites).where(eq(sites.id, siteId))
  const stamp = () =>
    deps.db.update(sites).set({ assetsCheckedAt: new Date() }).where(eq(sites.id, siteId))
  if (!site) return { status: 'skipped', favicon: false, cover: false, reason: 'site not found' }
  if (!deps.store) {
    // Not stamped: once a store is configured the next fetch queues the site again.
    return { status: 'skipped', favicon: false, cover: false, reason: 'no asset store configured' }
  }

  let html = ''
  let baseUrl = site.homeUrl
  try {
    const page = await deps.http.get(site.homeUrl, { accept: 'text/html, */*;q=0.5' })
    if (page.status === 200) {
      html = page.body
      baseUrl = page.finalUrl
    }
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
  }

  let faviconKey: string | null = null
  for (const url of findIconUrls(html, baseUrl)) {
    const got = await fetchBytes(deps.http, url, MAX_ICON_BYTES)
    if (!got || !got.type.startsWith('image/')) continue
    const icon = await normalizeIcon(got.bytes, got.type)
    faviconKey = `sites/${siteId}/favicon-${site.updatedAt.getTime()}.${icon.ext}`
    await deps.store.put(faviconKey, icon.bytes, icon.type)
    break
  }

  let coverKey: string | null = null
  const coverUrl = html ? findCoverUrl(html, baseUrl) : null
  if (coverUrl) {
    const got = await fetchBytes(deps.http, coverUrl, MAX_COVER_BYTES)
    if (got?.type.startsWith('image/')) {
      const cover = await normalizeCover(got.bytes)
      if (cover) {
        coverKey = `sites/${siteId}/cover-${site.updatedAt.getTime()}.${cover.ext}`
        await deps.store.put(coverKey, cover.bytes, cover.type)
      }
    }
  }

  await deps.db
    .update(sites)
    .set({
      assetsCheckedAt: new Date(),
      ...(faviconKey ? { faviconKey } : {}),
      ...(coverKey ? { coverKey } : {}),
    })
    .where(eq(sites.id, siteId))
  return { status: 'done', favicon: faviconKey !== null, cover: coverKey !== null }
}
