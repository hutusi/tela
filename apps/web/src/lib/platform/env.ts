/**
 * True when running inside the Cloudflare Workers runtime (deployed or `preview`).
 * Detected from the runtime's own globals: getCloudflareContext() would start a local
 * Workers proxy under `next start` and answer as if deployed.
 */
export async function onCloudflare(): Promise<boolean> {
  const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown }
  return g.navigator?.userAgent === 'Cloudflare-Workers' || typeof g.WebSocketPair === 'function'
}

/**
 * Dev-auth mode signs every request in as the development user. It can only be turned on
 * with TELA_DEV_AUTH=1 and is refused on Cloudflare, so it cannot leak into a deployment.
 */
export async function isDevAuthEnabled(): Promise<boolean> {
  if (process.env.TELA_DEV_AUTH !== '1') return false
  return !(await onCloudflare())
}

let warned = false

/** Secret for signing image-proxy URLs; falls back to a fixed value only in dev-auth mode. */
export async function imageProxySecret(): Promise<string | null> {
  const secret = process.env.IMAGE_PROXY_SECRET
  if (secret) return secret
  if (await isDevAuthEnabled()) return 'dev-image-proxy-secret'
  if (!warned) {
    warned = true
    console.warn(
      '[tela] IMAGE_PROXY_SECRET is not set; article images are served from their origins',
    )
  }
  return null
}
