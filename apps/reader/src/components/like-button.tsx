import { useTranslations } from 'use-intl'
import { useStore } from '../store/hooks'
import { Glyph, HEART, HEART_FILLED } from './glyph'

/**
 * An absolute like, applied on this device at once and synced behind it (ADR 0025). The toolbar's
 * shows the count beside the heart; without a count, as at the end of an article, it says Like or
 * Liked instead.
 */
export function LikeButton({
  articleId,
  liked,
  likeCount,
  testId = 'like-button',
}: {
  articleId: number
  liked: boolean
  likeCount?: number
  testId?: string
}) {
  const t = useTranslations('reader')
  const { store } = useStore()
  const label = liked ? t('liked') : t('like')
  return (
    <button
      type="button"
      aria-pressed={liked}
      data-testid={testId}
      onClick={() => store.mutate({ type: 'setLiked', articleId, liked: !liked })}
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink ${
        liked ? 'border-ink bg-ink text-paper' : 'border-thumb bg-transparent text-ink'
      }`}
    >
      <Glyph size={14} className="shrink-0">
        {liked ? HEART_FILLED : HEART}
      </Glyph>
      {likeCount === undefined ? (
        <span>{label}</span>
      ) : (
        <>
          <span>{likeCount}</span>
          <span className="sr-only">{label}</span>
        </>
      )}
    </button>
  )
}
