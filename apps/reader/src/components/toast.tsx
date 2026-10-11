import { pauseToast, resumeToast, runToastAction, useToast } from '../lib/toasts'

/**
 * The reader's toast (`lib/toasts.ts`), fixed at the foot of the page, centred, on ink. The live
 * region is always there, empty or not, so a screen reader hears each new message. Its foot sits
 * above the phone reader's bottom bar while that shows (`--bottom-bar`).
 *
 * Its time stops while a pointer is over it or focus is in it, so an Undo being reached for is
 * never taken away, nor focus dropped to the page as it goes.
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
              data-testid="toast-action"
              className="shrink-0 cursor-pointer font-semibold text-inherit underline underline-offset-2"
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
