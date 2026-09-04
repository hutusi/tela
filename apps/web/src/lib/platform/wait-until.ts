import { getCloudflareContext } from '@opennextjs/cloudflare'
import { onCloudflare } from './env'

/**
 * Let best-effort background work (filling a cache) outlive the response. On Cloudflare that
 * needs ctx.waitUntil, or the isolate may be torn down first; elsewhere the promise simply runs
 * detached. Failures are swallowed.
 */
export async function waitUntil(work: Promise<unknown>): Promise<void> {
  const detached = work.catch(() => undefined)
  if (!(await onCloudflare())) return
  try {
    const { ctx } = await getCloudflareContext({ async: true })
    ctx.waitUntil(detached)
  } catch {
    // Outside a request context: nothing to attach to.
  }
}
