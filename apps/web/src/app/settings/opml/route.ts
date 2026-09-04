import { exportSubscriptionsOpml } from '@tela/db/queries'
import { getSessionUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export const dynamic = 'force-dynamic'

/** Download the member's subscriptions as OPML. */
export async function GET(): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return new Response('sign in first', { status: 401 })
  const opml = await exportSubscriptionsOpml(await getDb(), user.id)
  return new Response(opml, {
    headers: {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="tela-subscriptions.opml"',
      'cache-control': 'no-store',
    },
  })
}
