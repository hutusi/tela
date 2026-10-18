/**
 * A phone's bottom sheet (Tela Mobile): a modal dialog from the foot of the screen, so the page
 * under it is out of reach and Tab stays in it, with the scrim under it (`dialog.sheet::backdrop`,
 * styles.css) and a grab handle at its top. Esc, a close request with no key (Android's back
 * gesture) and a tap on the scrim close it, and focus goes back to the control that opened it.
 * Recommend on the article and Move to in Settings › Subscriptions open in one.
 */
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'

export function Sheet({
  labelledBy,
  opener,
  onClose,
  testId,
  className = 'gap-3.5',
  children,
}: {
  /** The id of the sheet's title, which names the dialog. */
  labelledBy: string
  /** Where focus goes back to when the sheet closes. */
  opener: RefObject<HTMLElement | null>
  onClose: () => void
  testId: string
  /** The column's spacing under the handle. */
  className?: string
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    const back = opener.current
    // Once: React may run this twice in development, and an open dialog refuses a second.
    if (el && !el.open) el.showModal()
    return () => {
      el?.close()
      back?.focus()
    }
  }, [opener])
  return (
    <dialog
      ref={dialog}
      aria-labelledby={labelledBy}
      // A close request with no key, such as Android's back gesture.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // Esc is taken here, wherever focus is in the sheet, and marked handled, so the page's own
      // Esc (the reader's closes the article) does not act under it.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      // The dialog is its content's box, so a click on the dialog itself is one on the scrim.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="sheet mx-0 mb-0 mt-auto max-h-[calc(100dvh-24px)] w-full max-w-none overflow-y-auto md:mx-auto md:max-w-[560px] rounded-t-[18px] border-0 bg-surface p-0 text-ink shadow-[0_-8px_30px_rgba(0,0,0,.12)] animate-fade"
      data-testid={testId}
    >
      <div
        className={`flex flex-col px-5 pb-[max(30px,env(safe-area-inset-bottom))] pt-2.5 ${className}`}
      >
        <span aria-hidden="true" className="h-1 w-9 self-center rounded-sm bg-thumb" />
        {children}
      </div>
    </dialog>
  )
}
