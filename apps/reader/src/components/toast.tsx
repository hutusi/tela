import { runToastAction, useToast } from '../lib/toasts'

/**
 * The reader's toast (`lib/toasts.ts`), fixed at the foot of the page, centred, on ink. The live
 * region is always there, empty or not, so a screen reader hears each new message. Its foot sits
 * above the phone reader's bottom bar while that shows (`--bottom-bar`).
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
        <div
          key={toast.id}
          data-testid="toast"
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
