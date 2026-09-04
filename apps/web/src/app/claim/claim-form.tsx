'use client'

import { useTranslations } from 'next-intl'
import { useActionState } from 'react'
import { type ClaimStartState, startClaimAction } from './actions'

const initial: ClaimStartState = { error: null, query: '' }

export function ClaimStartForm() {
  const t = useTranslations('claim')
  const [state, action, pending] = useActionState(startClaimAction, initial)
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          name="url"
          type="text"
          required
          defaultValue={state.query}
          placeholder="https://your.blog"
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted"
          data-testid="claim-url"
        />
        <button
          type="submit"
          disabled={pending}
          className="whitespace-nowrap rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          data-testid="claim-continue"
        >
          {pending ? t('searching') : t('continue')}
        </button>
      </div>
      {state.error ? (
        <p className="text-sm text-[oklch(0.5_0.15_25)]">{t(`errors.${state.error}`)}</p>
      ) : null}
    </form>
  )
}
