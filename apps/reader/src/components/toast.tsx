import { useEffect } from 'react'
import { currentToast, pauseToast, resumeToast, runToastAction, useToast } from '../lib/toasts'

/** A field typing goes into: U there is a letter. A check box or a radio is not one. */
const FIELD =
  'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * The reader's toast (`lib/toasts.ts`), fixed at the foot of the page, centred, on ink. The live
 * region is always there, empty or not, so a screen reader hears each new message. Its foot sits
 * above the phone reader's bottom bar while that shows (`--bottom-bar`).
 *
 * Its time stops while a pointer is over it or focus is in it, so an Undo being reached for is
 * never taken away, nor focus dropped to the page as it goes; and `u` presses it on any page that
 * shows it, as the key cap in it says.
 */
export function Toast() {
  const toast = useToast()
  // U presses Undo wherever the toast offers it (a blog left in Settings as much as a mark-all on
  // /reading), so the key lives with the toast, not with one page. Read when it is pressed: the
  // toast showing then, and the page then. Never typed into a field, never under a modal dialog,
  // which owns the keys while it is open, and never on /admin, whose console has its own toast
  // and its own U (`admin/keys.ts`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'u' || e.repeat) return
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const { pathname } = window.location
      if (pathname === '/admin' || pathname.startsWith('/admin/')) return
      if (e.target instanceof Element && e.target.closest(FIELD)) return
      if (document.querySelector('dialog:modal')) return
      const shown = currentToast()
      if (!shown?.action) return
      e.preventDefault()
      runToastAction(shown.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(28px+var(--bottom-bar,0px))] z-30 flex justify-center px-4"
    >
      {toast ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only stop its time while it is used; the button in it is what acts
        <div
          key={toast.id}
          data-testid="toast"
          onPointerEnter={() => pauseToast(toast.id)}
          onPointerLeave={(e) => {
            // Focus still in it holds it as the pointer did.
            if (!e.currentTarget.contains(document.activeElement)) resumeToast(toast.id)
          }}
          onFocus={() => pauseToast(toast.id)}
          onBlur={(e) => {
            const el = e.currentTarget
            // Moving between its own controls, or with the pointer still over it, is still using it.
            if (el.contains(e.relatedTarget as Node | null) || el.matches(':hover')) return
            resumeToast(toast.id)
          }}
          className="pointer-events-auto flex max-w-full animate-fade items-center gap-3.5 rounded-[10px] bg-ink px-[18px] py-3 text-[13.5px] text-paper shadow-[0_8px_24px_rgba(0,0,0,.18)]"
        >
          <span className="min-w-0">{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              onClick={() => runToastAction(toast.id)}
              aria-keyshortcuts="u"
              data-testid="toast-action"
              className="-my-1.5 flex shrink-0 cursor-pointer items-center gap-2 py-1.5 font-semibold text-inherit"
            >
              <span className="underline underline-offset-2">{toast.action.label}</span>
              {/* No key to press on a phone. */}
              <span aria-hidden="true" className="pointer-coarse:hidden">
                <kbd className="rounded-[4px] border border-paper/35 px-1 font-sans text-[10.5px] leading-[14px] font-normal opacity-75">
                  U
                </kbd>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
