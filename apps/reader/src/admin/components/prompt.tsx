/**
 * An action's question, inline where it was asked: a confirmation strip (its consequence in words,
 * then a yes and a no), or a short form for the words an action needs (a rejection's reason, how
 * many uses, a code, an address). Never `window.confirm`: a dialog would take the keys away from
 * the console and say nothing about what the yes does.
 */
import { normalizeInviteCode } from '@tela/shared'
import { ADMIN_REASON_MAX, type AdminActArgs } from '@tela/shared/admin'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { actionLook, promptFor } from '../act'
import type { Prompt } from '../use-act'
import { ActionButton } from './buttons'

/** The most uses a code may be given at once, as tela-api caps it. */
const USES_MAX = 100_000

const FIELD =
  'w-full min-w-0 rounded-lg border border-line bg-field px-3 py-2 text-[14px] text-ink outline-none focus:border-muted'

export function ActionPrompt({
  prompt,
  busy,
  onAnswer,
  onCancel,
}: {
  prompt: Prompt
  busy: boolean
  onAnswer: (args?: AdminActArgs) => void
  onCancel: () => void
}) {
  const asks = promptFor(prompt.action, prompt.args)
  if (asks && 'input' in asks) {
    return <InputForm prompt={prompt} busy={busy} onAnswer={onAnswer} onCancel={onCancel} />
  }
  return <ConfirmStrip prompt={prompt} busy={busy} onAnswer={onAnswer} onCancel={onCancel} />
}

function ConfirmStrip({
  prompt,
  busy,
  onAnswer,
  onCancel,
}: {
  prompt: Prompt
  busy: boolean
  onAnswer: (args?: AdminActArgs) => void
  onCancel: () => void
}) {
  const t = useTranslations('admin.shell')
  const yes = useRef<HTMLButtonElement>(null)
  // The yes has focus, so Enter answers it; Esc, the ledger's keys take the question back.
  useEffect(() => {
    yes.current?.focus()
  }, [])
  return (
    <div className="flex flex-col gap-2.5" data-testid="admin-confirm">
      <p className="m-0 text-[13.5px] leading-normal text-ink-2">{t(`confirm.${prompt.action}`)}</p>
      <div className="flex flex-wrap gap-2">
        <ActionButton
          ref={yes}
          look={actionLook(prompt.action, 0)}
          disabled={busy}
          onClick={() => onAnswer(prompt.args)}
          data-testid="admin-confirm-yes"
        >
          {t('confirm.yes')}
        </ActionButton>
        <ActionButton look="ghost" onClick={onCancel}>
          {t('confirm.no')}
        </ActionButton>
      </div>
    </div>
  )
}

function InputForm({
  prompt,
  busy,
  onAnswer,
  onCancel,
}: {
  prompt: Prompt
  busy: boolean
  onAnswer: (args?: AdminActArgs) => void
  onCancel: () => void
}) {
  const t = useTranslations('admin.shell')
  const id = useId()
  const asks = promptFor(prompt.action)
  const kind = asks && 'input' in asks ? asks.input : 'reason'
  const [text, setText] = useState('')
  const [uses, setUses] = useState(kind === 'code' ? '1' : '')
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [])

  const count = Number(uses)
  const usesValid = Number.isInteger(count) && count >= 1 && count <= USES_MAX
  const args: AdminActArgs | null = (() => {
    switch (kind) {
      case 'reason': {
        const reason = text.trim()
        return reason && reason.length <= ADMIN_REASON_MAX ? { reason } : null
      }
      case 'uses':
        return usesValid ? { uses: count } : null
      case 'code': {
        const code = normalizeInviteCode(text)
        return code && usesValid ? { code, uses: count } : null
      }
      case 'email': {
        const email = text.trim()
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : null
      }
    }
  })()

  const label = 'text-[12.5px] font-medium text-muted'
  return (
    <form
      className="flex flex-col gap-2.5"
      data-testid="admin-input"
      onSubmit={(e) => {
        e.preventDefault()
        if (args && !busy) onAnswer(args)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onCancel()
      }}
    >
      <label htmlFor={`${id}-text`} className={label}>
        {t(`input.${kind}`)}
      </label>
      {kind === 'reason' ? (
        <textarea
          id={`${id}-text`}
          ref={first}
          rows={2}
          maxLength={ADMIN_REASON_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${FIELD} resize-y`}
        />
      ) : kind === 'uses' ? (
        <input
          id={`${id}-text`}
          ref={first}
          type="number"
          inputMode="numeric"
          min={1}
          max={USES_MAX}
          step={1}
          value={uses}
          onChange={(e) => setUses(e.target.value)}
          className={FIELD}
        />
      ) : (
        <input
          id={`${id}-text`}
          ref={first}
          type={kind === 'email' ? 'email' : 'text'}
          autoComplete="off"
          spellCheck={false}
          maxLength={kind === 'email' ? 254 : 40}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${FIELD} ${kind === 'code' ? 'font-mono uppercase' : ''}`}
        />
      )}
      {kind === 'code' ? (
        <>
          <label htmlFor={`${id}-uses`} className={label}>
            {t('input.uses_new')}
          </label>
          <input
            id={`${id}-uses`}
            type="number"
            inputMode="numeric"
            min={1}
            max={USES_MAX}
            step={1}
            value={uses}
            onChange={(e) => setUses(e.target.value)}
            className={FIELD}
          />
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton
          type="submit"
          look={actionLook(prompt.action, 0)}
          disabled={busy || args === null}
          data-testid="admin-input-submit"
        >
          {t('input.submit')}
        </ActionButton>
        <ActionButton look="ghost" onClick={onCancel}>
          {t('input.cancel')}
        </ActionButton>
      </div>
    </form>
  )
}
