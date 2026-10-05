/**
 * The undo toast: what the last action did, for six seconds, with Undo while it can be taken back
 * (U does the same). At the foot of the content column, centred; the live region is always there,
 * so a reader of the screen hears each new message.
 */
import { useEffect } from 'react'
import { useTranslations } from 'use-intl'
import { useAdmin } from '../context'
import { KeyHint } from './buttons'
import { Dot } from './record'

/** How long a message stays, as the design has it. */
export const TOAST_MS = 6000

export function UndoToast() {
  const t = useTranslations('admin.shell')
  const { toast, dismiss, undo } = useAdmin()
  const id = toast?.id ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new message gets its own six seconds
  useEffect(() => {
    if (id === null) return
    // This toast's own time: a timer that fires just as a newer one arrives takes nothing down.
    const timer = setTimeout(() => dismiss(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id])
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 md:absolute"
    >
      {toast ? (
        <div
          key={toast.id}
          className="pointer-events-auto flex max-w-full animate-fade items-center gap-3 rounded-full bg-ink py-2 pr-2 pl-[18px] text-[13.5px] font-medium text-paper shadow-lg"
          data-testid="admin-toast"
        >
          {toast.error ? <Dot tone="bad" /> : null}
          <span className="min-w-0 truncate">{toast.text}</span>
          {toast.undo ? (
            <button
              type="button"
              onClick={undo}
              className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full px-2.5 py-1 font-semibold text-paper underline underline-offset-2"
              data-testid="admin-undo"
            >
              {t('toast.undo')}
              <KeyHint>U</KeyHint>
            </button>
          ) : (
            <span className="w-2.5 shrink-0" />
          )}
        </div>
      ) : null}
    </div>
  )
}
