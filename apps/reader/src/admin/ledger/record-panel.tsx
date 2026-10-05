/**
 * The record beside the table (the design's 2a): its state, where it sits in the list with ↑ ↓,
 * the area's own body, and its actions with their keys. From `lg` it stands beside the table and
 * scrolls on its own; below `lg` it covers the page, with a way back to the list, and is a modal
 * dialog: focus goes into it, Tab stays in it, and closing it hands focus back to the row.
 */
import type { AdminActArgs, AdminActionName, AdminRowBase, LedgerArea } from '@tela/shared/admin'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { useTranslations } from 'use-intl'
import { actionLook } from '../act'
import type { Act, AnyAreaSpec } from '../area'
import { ActionButton, KeyHint } from '../components/buttons'
import { ActionPrompt } from '../components/prompt'
import { StatusPill } from '../components/record'
import type { Prompt } from '../use-act'

/**
 * An area's render function as a component of its own type. An area may build its spec anew on
 * every render; given to React as the element type, each new function would be a new component,
 * and the record would lose its state (a half-edited topic list) at every key press. Called from
 * here, its hooks belong to this one stable component.
 */
export function Rendered<P>({ render, props }: { render: (props: P) => ReactNode; props: P }) {
  return <>{render(props)}</>
}

const ICON =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-thumb text-ink-2 hover:text-ink disabled:cursor-default disabled:opacity-40'

/** Tailwind's `lg`, where the panel stands beside the table. */
const BESIDE = '(min-width: 64rem)'

/** Whether the panel stands beside the table now. A server render, which has no screen, says so. */
function useBeside(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(BESIDE)
      query.addEventListener('change', changed)
      return () => query.removeEventListener('change', changed)
    },
    () => window.matchMedia(BESIDE).matches,
    () => true,
  )
}

/** What Tab can reach inside an element, in order, leaving out what is hidden or disabled. */
function tabStops(root: HTMLElement): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  return [...all].filter((el) => el.getClientRects().length > 0)
}

/**
 * Below `lg` the panel covers the page as a modal dialog: focus moves into it as it opens, and Tab
 * and Shift+Tab go round inside it. Either way, closing it with focus inside (✕, Back, Esc on one
 * of its buttons) hands focus back to the row it showed, rather than to the top of the page.
 */
function useDialogFocus(ref: RefObject<HTMLElement | null>, modal: boolean, rowId: string | null) {
  const shown = useRef(rowId)
  shown.current = rowId
  useEffect(() => {
    const panel = ref.current
    if (!panel || !modal) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const stops = tabStops(panel)
      const first = stops[0]
      const last = stops.at(-1)
      if (!first || !last) {
        e.preventDefault()
        return
      }
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    panel.addEventListener('keydown', onKey)
    return () => panel.removeEventListener('keydown', onKey)
  }, [ref, modal])
  // A layout effect's cleanup runs while the panel is still in the page, so it can tell where the
  // focus was; the row takes it once the table has drawn without the panel.
  useLayoutEffect(() => {
    const panel = ref.current
    return () => {
      const id = shown.current
      if (!panel?.contains(document.activeElement) || id === null) return
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-testid="admin-row"][data-row-id="${CSS.escape(id)}"] a[href]`,
          )
          ?.focus()
      })
    }
  }, [ref])
}

/**
 * From `lg` the panel sticks to the top of the column once the column has scrolled to it; until
 * then it starts below the area's header and filters. Held to the room under its top, so its
 * actions are never below the fold while it waits to stick: a fixed height would push them off
 * the screen on every record opened from the top of the list. A style, not state: nothing renders.
 */
function useFitBelowFold(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = ref.current
    const scroller = panel?.closest('main')
    if (!panel || !scroller) return
    const beside = window.matchMedia(BESIDE)
    // Scroll, resize and resize-observer callbacks each come at most once a frame already.
    const fit = () => {
      if (!beside.matches) {
        panel.style.maxHeight = ''
        return
      }
      const room = scroller.getBoundingClientRect().bottom - panel.getBoundingClientRect().top
      panel.style.maxHeight = `${Math.max(320, Math.round(room - 16))}px`
    }
    fit()
    scroller.addEventListener('scroll', fit, { passive: true })
    window.addEventListener('resize', fit)
    // What sits above the table can change height (an area's header that loads): measure again.
    const above = new ResizeObserver(fit)
    if (scroller.firstElementChild) above.observe(scroller.firstElementChild)
    return () => {
      scroller.removeEventListener('scroll', fit)
      window.removeEventListener('resize', fit)
      above.disconnect()
    }
  }, [ref])
}

export function RecordPanel({
  spec,
  row,
  detail,
  index,
  total,
  missing,
  prompt,
  busy,
  onStep,
  onClose,
  onAction,
  onAnswer,
  onCancel,
  act,
  open,
}: {
  spec: AnyAreaSpec
  /** Null while the record is being found, or when it is gone (`missing`). */
  row: AdminRowBase | null
  detail: unknown
  /** Its place in the list as shown, from 0; -1 when the list does not show it. */
  index: number
  total: number
  missing: boolean
  prompt: Prompt | null
  busy: boolean
  onStep: (step: 1 | -1) => void
  onClose: () => void
  onAction: (action: AdminActionName) => void
  onAnswer: (args?: AdminActArgs) => void
  onCancel: () => void
  act: Act
  open: (area: LedgerArea, id: string) => void
}) {
  const t = useTranslations('admin.shell')
  const status = row ? spec.status(row) : null
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const modal = !useBeside()
  useFitBelowFold(panel)
  useDialogFocus(panel, modal, row?.id ?? null)
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal comes only with role="dialog"
    <section
      ref={panel}
      // A dialog only while it covers the page; beside the table, a region of it.
      role={modal ? 'dialog' : undefined}
      aria-modal={modal ? true : undefined}
      aria-labelledby={row ? titleId : undefined}
      aria-label={row ? undefined : t('ledger.record')}
      tabIndex={-1}
      className="fixed inset-0 z-30 flex min-w-0 animate-fade flex-col overflow-hidden bg-paper outline-none lg:sticky lg:top-0 lg:right-auto lg:bottom-auto lg:left-auto lg:z-auto lg:max-h-[calc(100dvh-60px)] lg:rounded-[14px] lg:border lg:border-line lg:bg-surface"
      data-testid="admin-record"
    >
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 cursor-pointer border-0 border-b border-line bg-transparent px-4 py-3 text-left text-[13.5px] font-medium text-ink-2 hover:text-ink lg:hidden"
      >
        {t('ledger.backToList')}
      </button>
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pr-3 pl-[18px]">
        {status ? (
          <span className="flex min-w-0 shrink">
            <StatusPill tone={status.tone} label={status.label} />
          </span>
        ) : null}
        <div className="flex-1" />
        {index >= 0 ? (
          <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted tabular-nums">
            {t('ledger.position', { i: index + 1, n: total })}
          </span>
        ) : null}
        <button
          type="button"
          className={ICON}
          aria-label={t('ledger.previous')}
          title={t('ledger.previous')}
          disabled={index <= 0}
          onClick={() => onStep(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={ICON}
          aria-label={t('ledger.next')}
          title={t('ledger.next')}
          disabled={index < 0 || index >= total - 1}
          onClick={() => onStep(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[14px] text-muted hover:bg-hover hover:text-ink"
          aria-label={t('ledger.close')}
          title={t('ledger.close')}
          onClick={onClose}
          data-testid="admin-record-close"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-[18px]">
        {row ? (
          <>
            {/* The record's name, as the design heads it: the areas give the body below. */}
            <header className="flex flex-col gap-1">
              <h2
                id={titleId}
                className="m-0 font-serif text-[28px] leading-[1.12] font-medium tracking-[-0.01em] [overflow-wrap:anywhere]"
              >
                {spec.name.title(row)}
              </h2>
              <p className="m-0 text-[13px] text-muted [overflow-wrap:anywhere]">
                {spec.name.sub(row)}
              </p>
            </header>
            <Rendered key={row.id} render={spec.Record} props={{ row, detail, act, open, busy }} />
          </>
        ) : (
          <p className="m-0 text-[14px] text-muted">
            {missing ? t('errors.not_found') : t('ledger.loading')}
          </p>
        )}
      </div>
      {row && (prompt || row.actions.length > 0) ? (
        <div className="shrink-0 border-t border-line px-4 py-3">
          {prompt ? (
            <ActionPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onCancel={onCancel} />
          ) : (
            <div className="flex flex-wrap gap-2">
              {row.actions.map((action, i) => (
                <ActionButton
                  key={action}
                  look={actionLook(action, i)}
                  disabled={busy}
                  onClick={() => onAction(action)}
                  className="pr-2.5"
                  data-testid="admin-record-action"
                  data-action={action}
                >
                  {spec.actionLabel?.(row, action) ?? t(`actions.${action}.label`)}
                  {i < 3 ? <KeyHint>{i + 1}</KeyHint> : null}
                </ActionButton>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}
