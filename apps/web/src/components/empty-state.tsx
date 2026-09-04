import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

export async function EmptyState({
  unread,
  hasSubscriptions,
}: {
  unread: number
  hasSubscriptions: boolean
}) {
  const t = await getTranslations('reader')
  const tl = await getTranslations('list')
  const tn = await getTranslations('nav')
  return (
    <main
      className="hidden items-center justify-center p-10 text-muted animate-fade lg:flex"
      data-testid="empty-state"
    >
      <div className="max-w-[280px] text-center">
        <div className="mb-1.5 font-serif text-[26px] text-ink">
          {hasSubscriptions ? t('unreadCount', { n: unread }) : tl('empty')}
        </div>
        <div className="text-[13.5px] leading-normal">
          {hasSubscriptions ? (
            t('pickArticle')
          ) : (
            <Link href="/add" className="underline">
              {tn('addFeed')}
            </Link>
          )}
        </div>
      </div>
    </main>
  )
}
