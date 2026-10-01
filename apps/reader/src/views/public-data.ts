/**
 * A public page's JSON as the views read it, whichever tela-api answered. The previous API (a
 * rollback, or a browser that cached its answer under `stale-while-revalidate`: up to a day for
 * Discover and a blog's page, five minutes for a profile)
 * sends no counts, notes, claimant or account id; a view that read them as given threw, and with
 * no error boundary the whole page went blank. One normalized copy per answer, so a page keyed by
 * its data's identity sees the same object every render.
 */
import type { ProfileData, SiteData } from './types'

const profiles = new WeakMap<object, ProfileData>()
const sites = new WeakMap<object, SiteData>()

export function profileDataOf(raw: ProfileData): ProfileData {
  const held = profiles.get(raw)
  if (held) return held
  const data: ProfileData = {
    ...raw,
    // An empty id is no member to follow: the page offers no Follow until it has one.
    profile: { ...raw.profile, id: raw.profile.id ?? '' },
    // What it never counted is left out, not shown as nobody.
    counts: raw.counts ?? null,
    recommendations: raw.recommendations.map((r) => ({ ...r, listed: r.listed ?? false })),
    subscriptions:
      raw.subscriptions?.map((s) => ({ ...s, description: s.description ?? null })) ?? null,
    liked: raw.liked ?? null,
  }
  profiles.set(raw, data)
  return data
}

export function siteDataOf(raw: SiteData): SiteData {
  const held = sites.get(raw)
  if (held) return held
  const { site } = raw
  const data: SiteData = {
    ...raw,
    site: {
      ...site,
      claimant:
        site.claimant !== undefined
          ? site.claimant
          : site.claimedBy
            ? { handle: site.claimedBy, displayName: null, bio: null }
            : null,
      postsLast30d: site.postsLast30d ?? null,
    },
    notes: raw.notes ?? [],
  }
  sites.set(raw, data)
  return data
}
