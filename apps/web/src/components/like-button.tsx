'use client'

import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { toggleLikeAction } from '@/app/reading/actions'

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
          // toggleLikeAction returns the post-toggle truth, so there is nothing left to
          // re-render for; a refresh here would re-run the whole page for a number we hold.
          setState(await toggleLikeAction(articleId))
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
