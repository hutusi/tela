import { getReadingRevision } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { getSessionUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export const dynamic = 'force-dynamic'

/**
 * What an open article is waiting on, as one opaque string (see `readingRevision`).
 *
 * This exists so a reader tab waiting for a translation or a full-text fetch does not have to
 * re-render the reading page to find out whether anything changed. One indexed row instead of a
 * sidebar aggregate, a sixty-article list and an article body.
 */
export async function GET(req: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return new Response('unauthorized', { status: 401 })
  const q = new URL(req.url).searchParams
  const articleId = Number(q.get('article'))
  const lang = q.get('lang')
  if (!Number.isInteger(articleId) || articleId <= 0 || !isReadingLanguage(lang)) {
    return new Response('bad request', { status: 400 })
  }
  const revision = await getReadingRevision(await getDb(), articleId, lang)
  if (revision === null) return new Response('not found', { status: 404 })
  return Response.json({ revision }, { headers: { 'cache-control': 'no-store' } })
}
