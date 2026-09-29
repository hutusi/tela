import { useTranslations } from 'use-intl'
import { useStore } from '../store/hooks'

/** An absolute like, applied on this device at once and synced behind it (ADR 0025). */
export function LikeButton({
  articleId,
  liked,
  likeCount,
}: {
  articleId: number
  liked: boolean
  likeCount: number
}) {
  const t = useTranslations('reader')
  const { store } = useStore()
  return (
    <button
      type="button"
      aria-pressed={liked}
      data-testid="like-button"
      onClick={() => store.mutate({ type: 'setLiked', articleId, liked: !liked })}
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink ${
        liked ? 'border-ink bg-ink text-paper' : 'border-thumb bg-transparent text-ink'
      }`}
    >
      <span aria-hidden="true">{liked ? '♥' : '♡'}</span>
      <span>{likeCount}</span>
      <span className="sr-only">{liked ? t('liked') : t('like')}</span>
    </button>
  )
}
