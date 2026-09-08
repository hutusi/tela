import { getArticle } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { getSessionUser } from '@/lib/auth'
import { claimExtraction } from '@/lib/extraction'
import { getDb } from '@/lib/platform/db'
import { waitUntil } from '@/lib/platform/wait-until'
import { buildReaderData } from '@/lib/reader-data'

export const dynamic = 'force-dynamic'

/**
 * The reader pane's contents, as JSON.
 *
 * Opening an article this way costs a route handler — around 20 ms — where re-rendering the page
 * costs a React server render at around 67 ms, against a 10 ms Workers Free budget (ADR 0017).
 * The page still renders the pane itself for a direct link; this serves every click after that.
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
  const db = await getDb()
  const article = await getArticle(db, user.id, articleId, { translateTo: lang })
  if (!article) return new Response('not found', { status: 404 })
  await waitUntil(claimExtraction(article, db))
  return Response.json(await buildReaderData(article, lang), {
    headers: { 'cache-control': 'no-store' },
  })
}
