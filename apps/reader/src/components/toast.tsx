import { pauseToast, resumeToast, runToastAction, useToast } from '../lib/toasts'

/**
 * The reader's toast (`lib/toasts.ts`), fixed at the foot of the page, centred, on ink. The live
 * region is always there, empty or not, so a screen reader hears each new message. Its foot sits
 * above the phone reader's bottom bar while that shows (`--bottom-bar`).
 *
 * Its time stops while a pointer is over it or focus is in it, so an Undo being reached for is
 * never taken away, nor focus dropped to the page as it goes; and `u` presses it on /reading.
 */
export function Toast() {
  const toast = useToast()
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
