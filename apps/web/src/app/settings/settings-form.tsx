'use client'

import { useTranslations } from 'next-intl'
import { useActionState } from 'react'
import { type SettingsState, updateProfileAction } from './actions'

type Props = {
  handle: string
  displayName: string | null
  bio: string | null
  publicSubscriptions: boolean
}

const initial: SettingsState = { saved: false, error: null }

export function SettingsForm(props: Props) {
  const t = useTranslations('settings')
  const [state, action, pending] = useActionState(updateProfileAction, initial)
  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted'
  return (
    <form action={action} className="flex flex-col gap-4" data-testid="settings-form">
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('handle')}
        <div className="flex items-center gap-1">
          <span className="text-muted">@</span>
          <input
            name="handle"
            defaultValue={props.handle}
            required
            className={field}
            data-testid="settings-handle"
          />
        </div>
        <span className="text-xs font-normal text-muted">{t('handleHint')}</span>
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('displayName')}
        <input
          name="displayName"
          defaultValue={props.displayName ?? ''}
          className={field}
          data-testid="settings-display-name"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('bio')}
        <textarea
          name="bio"
          defaultValue={props.bio ?? ''}
          rows={3}
          maxLength={280}
          className={`${field} font-serif text-base`}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          name="publicSubscriptions"
          defaultChecked={props.publicSubscriptions}
        />
        {t('publicSubscriptions')}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          data-testid="settings-save"
        >
          {t('save')}
        </button>
        {state.saved ? (
          <span className="text-[13px] text-accent" data-testid="settings-saved">
            {t('saved')}
          </span>
        ) : null}
        {state.error ? (
          <span className="text-[13px] text-[oklch(0.5_0.15_25)]" data-testid="settings-error">
            {t(`errors.${state.error}`)}
          </span>
        ) : null}
      </div>
    </form>
  )
}
