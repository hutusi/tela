/** Public URL for a stored asset key (favicons, covers), or null when no asset host is set. */
export function assetUrl(key: string | null | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_ASSETS_URL?.replace(/\/+$/, '')
  if (!base || !key) return null
  return `${base}/${key}`
}

/** Posting cadence label key from posts in the last 30 days. */
export function cadenceKey(
  postsLast30d: number,
): 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quiet' {
  if (postsLast30d >= 20) return 'daily'
  if (postsLast30d >= 4) return 'weekly'
  if (postsLast30d >= 2) return 'biweekly'
  if (postsLast30d >= 1) return 'monthly'
  return 'quiet'
}
