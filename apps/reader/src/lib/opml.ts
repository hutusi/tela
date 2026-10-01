/**
 * Subscriptions in and out as OPML, and saving a member's file. Both are RPCs: the member needs
 * the answer, and a download has to name the member, which a plain link cannot.
 */
import { api, apiJson } from '../store/api'

export type AddError =
  | 'invalid_url'
  | 'fetch_failed'
  | 'rate_limited'
  | 'opml_invalid'
  | 'opml_too_large'

/** tela-api's answer, as the message a page has for it. */
export function addError(code: string | undefined): AddError {
  if (
    code === 'invalid_url' ||
    code === 'rate_limited' ||
    code === 'opml_invalid' ||
    code === 'opml_too_large'
  )
    return code
  return 'fetch_failed'
}

/** Import an OPML file: how many feeds it added, or why not. */
export async function importOpml(file: File): Promise<{ feeds: number } | { error: AddError }> {
  if (file.size > 1024 * 1024) return { error: 'opml_too_large' }
  try {
    const { status, body } = await apiJson<{ feeds?: number; error?: string }>(
      '/api/v1/feeds/opml',
      { method: 'POST', raw: await file.text() },
    )
    if (status !== 200 || body.feeds === undefined) return { error: addError(body?.error) }
    return { feeds: body.feeds }
  } catch {
    return { error: 'fetch_failed' }
  }
}

/**
 * Fetch one of the member's files and save it. Through `api()` rather than a link: a navigation
 * cannot name the member, and a tab still holding one account must not save the file of whoever
 * the session belongs to now. False when there was nothing to save.
 */
export async function saveDownload(path: string, fallbackName: string): Promise<boolean> {
  try {
    const res = await api(path)
    if (!res.ok) return false
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Some browsers read the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch {
    // Offline, or the tab is leaving (api() has said so already): there is nothing to save.
    return false
  }
}
