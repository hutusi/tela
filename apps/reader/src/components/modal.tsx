/**
 * A form that opens over the page, as a phone and a wider screen each want it: a native modal
 * `<dialog>` centred on the page from `md` (the crop's and the front door's), and a bottom sheet
 * below it (`Sheet`, as Recommend's and Move to's are). Either way the page under it is out of
 * reach and Tab stays in it; Esc, or a close request with no key, closes it, and focus goes back
 * to the control that opened it. One or the other is rendered, never both, so its test ids exist
 * once (ADR 0047).
 */
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { Sheet } from './sheet'

export function ResponsiveDialog({
  labelledBy,
  opener,
  onClose,
  testId,
  children,
}: {
  /** The id of the title, which names the dialog. */
  labelledBy: string
  /** Where focus goes back to when it closes. */
  opener: RefObject<HTMLElement | null>
  onClose: () => void
  testId: string
  children: ReactNode
}) {
  const phone = useMediaQuery(BELOW_MD)
  if (phone) {
    return (
      <Sheet
        labelledBy={labelledBy}
        opener={opener}
        onClose={onClose}
        testId={testId}
        className="gap-0 text-left"
      >
        <div className="mt-3 flex flex-col">{children}</div>
      </Sheet>
    )
  }
  return (
    <CentredDialog labelledBy={labelledBy} opener={opener} onClose={onClose} testId={testId}>
      {children}
    </CentredDialog>
  )
}

function CentredDialog({
  labelledBy,
  opener,
  onClose,
  testId,
  children,
}: {
  labelledBy: string
  opener: RefObject<HTMLElement | null>
  onClose: () => void
  testId: string
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
      // Esc, or a close request with no key: closing the dialog is cancelling it.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // Marked handled, so the page's own Esc does not act under it.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      className="m-auto max-h-[calc(100dvh-48px)] w-[min(500px,calc(100vw-32px))] animate-fade overflow-y-auto rounded-2xl border border-line bg-surface p-7 text-left text-ink shadow-[0_24px_60px_rgba(0,0,0,.18)] backdrop:bg-[rgba(0,0,0,.45)]"
      data-testid={testId}
    >
      {children}
    </dialog>
  )
}
