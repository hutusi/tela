/**
 * The app shell's service worker (ADR 0025): it caches the shell only, so a repeat visit paints
 * without the network. The API, content objects and images are never touched by it; the local
 * store is what makes reading work offline-ish, not the cache.
 */
const SW_URL = '/sw.js'
const UPGRADED_AT = 'tela.upgradedAt'

const sessionGet = (key: string) => {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
const sessionSet = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value)
  } catch {}
}

export const registerShell = {
  register() {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register(SW_URL).catch(() => undefined)
    })
  },

  /**
   * The server speaks a newer protocol than this shell: drop the cached shell and reload. At
   * most once a minute, so a deploy that has not reached every edge yet cannot loop the page.
   */
  async upgrade() {
    const last = Number(sessionGet(UPGRADED_AT) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionSet(UPGRADED_AT, String(Date.now()))
    try {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('tela-shell')).map((k) => caches.delete(k)))
      const reg = await navigator.serviceWorker?.getRegistration()
      await reg?.update()
    } finally {
      location.reload()
    }
  },
}
