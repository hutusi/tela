/**
 * A post refused for the day's limit on blogs the member does not subscribe to (ADR 0066), where
 * its body would be: the excerpt, what the limit is and when more open, *Subscribe to keep
 * reading* (a subscribed blog has no limit) and *Read it on the blog*. A limit is not an error,
 * so it is said calmly, as a translation's day is (ADR 0057).
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { useSubscriptionCap } from '../lib/member'
import { primeUsage } from '../lib/usage'
import { useStore, useTables } from '../store/hooks'
import type { PostRefusal } from '../store/objects'
import { localTime } from './translation-bar'

/**
 * What the one button does: subscribe; wait while the subscription is on its way to tela-api; or,
 * for a blog the member subscribes to already, ask for the post again.
 */
export type PostLimitAction = 'subscribe' | 'subscribing' | 'retry'

export function PostLimit({
  excerpt,
  excerptLang,
  url,
  refusal,
  action,
  onAction,
  now = Date.now(),
}: {
  excerpt: string | null
  excerptLang: string | undefined
  url: string | null
  refusal: Pick<PostRefusal, 'limit' | 'resetsAt'>
  action: PostLimitAction
  onAction: () => void
  now?: number
}) {
  const t = useTranslations('reader.postLimit')
  const tr = useTranslations('reader')
  const locale = useLocale()
  const titleId = useId()
  const { time, tomorrow } = localTime(refusal.resetsAt, locale, now)
  const limit = refusal.limit === null ? t('limitUnknown') : t('limit', { n: refusal.limit })
  const again = t(tomorrow ? 'againTomorrow' : 'againToday', { time })
  return (
    <div data-testid="body-refused">
      {excerpt ? (
        <div className="article-body" lang={excerptLang ?? ''} dir="auto">
          <p>{excerpt}</p>
        </div>
      ) : null}
      <section
        aria-labelledby={titleId}
        className="mt-6 rounded-xl border border-line bg-surface p-5"
      >
        <p id={titleId} className="m-0 font-medium text-ink">
          {t('title')}
        </p>
        <p
          className="mt-1.5 mb-0 text-[14px] leading-[1.5] text-ink-2"
          style={{ textWrap: 'pretty' }}
        >
          {/* Two sentences, joined as each language joins them: Chinese with no space. */}
          {t('line', { limit, again })}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <button
            type="button"
            onClick={onAction}
            disabled={action === 'subscribing'}
            aria-busy={action === 'subscribing' ? true : undefined}
            className="rounded-full border border-ink bg-ink px-4 py-[7px] text-[13px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60 max-md:min-h-[46px]"
            data-testid={action === 'retry' ? 'post-limit-retry' : 'post-limit-subscribe'}
          >
            {action === 'retry'
              ? tr('retry')
              : t(action === 'subscribing' ? 'subscribing' : 'subscribe')}
          </button>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px]"
              data-testid="post-limit-blog"
            >
              {t('onBlog')} ↗
            </a>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/**
 * The refused body with its button working: subscribing to the post's blog, then, once tela-api
 * has the subscription (the edge asks it, so a subscription only this device knows frees
 * nothing), asking for the post again, through `onRetry`. A blog the member subscribes to
 * already asks again at once. The subscription cap is checked first (ADR 0063), so a subscribe
 * tela-api would refuse in silence is a toast instead.
 */
export function RefusedBody({
  feedId,
  excerpt,
  excerptLang,
  url,
  refusal,
  onRetry,
}: {
  feedId: number
  excerpt: string | null
  excerptLang: string | undefined
  url: string | null
  refusal: PostRefusal
  onRetry: () => void
}) {
  const { store, objects } = useStore()
  const tables = useTables()
  const pastCap = useSubscriptionCap()
  // Offering Subscribe, the page asks once per tab how many the member may hold.
  useEffect(() => primeUsage(store.userId), [store])
  /** The subscribe this made, until tela-api has answered for it. */
  const [mid, setMid] = useState<string | null>(null)
  const unanswered = useCallback(() => mid !== null && store.unanswered(mid), [mid, store])
  const waiting = useSyncExternalStore(store.subscribe, unanswered, unanswered)
  const ask = useCallback(() => {
    // Any refusal may be this blog's: which blog a refused key is from is not known there.
    objects.forgetRefusals()
    onRetry()
  }, [objects, onRetry])
  // Answered: applied, the post is free now; refused (the cap), it is asked for and refused again.
  useEffect(() => {
    if (mid === null || waiting) return
    setMid(null)
    ask()
  }, [mid, waiting, ask])
  const subscribed = tables.subscriptions.get(feedId)?.deletedAt === null
  const action: PostLimitAction = waiting ? 'subscribing' : subscribed ? 'retry' : 'subscribe'
  const onAction = () => {
    if (action === 'retry') return ask()
    if (action !== 'subscribe' || pastCap(1)) return
    const stamp = store.mutate({ type: 'subscribe', feedId })
    if (stamp) setMid(stamp.mid)
  }
  return (
    <PostLimit
      excerpt={excerpt}
      excerptLang={excerptLang}
      url={url}
      refusal={refusal}
      action={action}
      onAction={onAction}
    />
  )
}
