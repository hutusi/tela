'use client'

import { useTranslations } from 'next-intl'
import { useActionState } from 'react'
import { type LoginState, sendCode, verifyCode } from './actions'

const initial: LoginState = { step: 'email', error: null }

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('login')
  const [state, action, pending] = useActionState(
    async (prev: LoginState, form: FormData) =>
      prev.step === 'code' ? verifyCode(prev, form) : sendCode(prev, form),
    initial,
  )

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      {state.step === 'code' ? (
        <>
          <input type="hidden" name="email" value={state.email ?? ''} />
          <p className="text-sm text-ink-2">{t('codeSent', { email: state.email ?? '' })}</p>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            placeholder={t('codePlaceholder')}
            className="rounded-lg border border-line bg-white px-3 py-2.5 font-mono text-lg tracking-widest outline-none focus:border-muted"
          />
        </>
      ) : (
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder={t('emailPlaceholder')}
          className="rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted"
        />
      )}
      {state.error ? (
        <p className="text-sm text-[oklch(0.5_0.15_25)]">{t(`errors.${state.error}`)}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
      >
        {state.step === 'code' ? t('verify') : t('sendCode')}
      </button>
    </form>
  )
}
