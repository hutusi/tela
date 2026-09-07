'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { toggleLikeAction } from '@/app/reading/actions'

export function LikeButton({
  articleId,
  liked,
  likeCount,
  listFiltersOnLiked = false,
}: {
  articleId: number
  liked: boolean
  likeCount: number
  /** The list beside this article is the Liked view, whose membership this button decides. */
  listFiltersOnLiked?: boolean
}) {
  const t = useTranslations('reader')
  const router = useRouter()
  const [state, setState] = useState({ liked, likeCount })
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={state.liked}
      data-testid="like-button"
      onClick={() =>
        start(async () => {
          setState((s) => ({ liked: !s.liked, likeCount: s.likeCount + (s.liked ? -1 : 1) }))
          // toggleLikeAction returns the post-toggle truth, so the button needs nothing more.
          setState(await toggleLikeAction(articleId))
          // The Liked view is the exception: its list is defined by the value just changed, so
          // the row has to leave (or arrive), and the sidebar's count with it. Everywhere else a
          // render would re-run the whole page for a number already in hand.
          if (listFiltersOnLiked) router.refresh()
        })
      }
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink disabled:opacity-70 ${
        state.liked ? 'border-ink bg-ink text-paper' : 'border-thumb bg-transparent text-ink'
      }`}
    >
      <span aria-hidden="true">{state.liked ? '♥' : '♡'}</span>
      <span>{state.likeCount}</span>
      <span className="sr-only">{state.liked ? t('liked') : t('like')}</span>
    </button>
  )
}
