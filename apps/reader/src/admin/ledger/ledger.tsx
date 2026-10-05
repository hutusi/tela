/**
 * The ledger (the design's 2a, "the ledger refined"): one area's rows under a filter and a search,
 * sortable, each with its likeliest action; the record beside them; a bulk bar while rows are
 * checked; and the keys for all of it. Generic over what an area gives (`AreaSpec`): the ledger
 * owns the frame, the area owns the words and the record's body.
 *
 * The address owns the filter, the search, the open record and the sort (`state.ts`). What the
 * keyboard focuses while no record is open, and which rows are checked, are this page's own: they
 * mean nothing in a copied link.
 */
import {
  ADMIN_FILTERS,
  ADMIN_LIST_LIMIT,
  type AdminActArgs,
  type AdminActionName,
  type AdminFilter,
  type AdminList,
  type AdminRowBase,
  type LedgerArea,
} from '@tela/shared/admin'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { actionLook, bulkOffer, bulkTargets, promptFor } from '../act'
import { NotAdmin } from '../api'
import type { Act, AnyAreaSpec } from '../area'
import { AREA_HOOKS } from '../areas'
import { ActionButton, CheckBox } from '../components/buttons'
import { ActionPrompt } from '../components/prompt'
import { StatusPill } from '../components/record'
import { useAdmin } from '../context'
import { keyDisposition, keyLike, ledgerCommand, scrollTarget, stepTo } from '../keys'
import {
  type LedgerState,
  ledgerHref,
  nextAfterAct,
  nextSort,
  openedRecord,
  parseLedgerState,
  patchedHref,
  type SortKey,
  sortRows,
  sortValueOf,
} from '../state'
import { type Prompt, useAdminAct } from '../use-act'
import { AreaHeader, FilterPills, KeyLegend, SearchBox } from './parts'
import { RecordPanel, Rendered } from './record-panel'

/** An area's ledger, or a quiet word while its slice is still to come. */
export function AreaLedger({ area }: { area: LedgerArea }) {
  // The shell keys this component by area, so the hook called here never changes between renders.
  const spec = AREA_HOOKS[area]()
  if (!spec) return <Unbuilt area={area} />
  return <Ledger area={area} spec={spec} />
}

function Unbuilt({ area }: { area: LedgerArea }) {
  const t = useTranslations('admin.shell')
  return (
    <div className="flex flex-col gap-6 pb-10">
      <AreaHeader area={area} />
      <p className="m-0 rounded-[10px] border border-dashed border-thumb px-4 py-3 text-[13.5px] text-muted">
        {t('ledger.unbuilt')}
      </p>
    </div>
  )
}

/** The grid of a row: the check, the name, three columns while the table is wide, the status, the
 *  likeliest action. With a record open, or below `lg`, only the check, the name and the status.
 *  An area with no bulk action (People) has no check column. */
const GRID = {
  open: 'grid-cols-[28px_minmax(0,1fr)_124px]',
  wide: 'grid-cols-[28px_minmax(0,1fr)_116px] lg:grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1fr)_124px] xl:grid-cols-[28px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1fr)_124px_116px]',
  openNoCheck: 'grid-cols-[minmax(0,1fr)_124px]',
  wideNoCheck:
    'grid-cols-[minmax(0,1fr)_116px] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1fr)_124px] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1fr)_124px_116px]',
} as const

type Loaded = {
  filter: AdminFilter
  q: string
  data: AdminList<AdminRowBase> | null
  failed: boolean
}

/** The last action on one row, for moving on once the list has loaded again. */
type Moving = { acted: string; before: string[] }

export function Ledger({
  area,
  spec,
  initial = null,
}: {
  area: LedgerArea
  spec: AnyAreaSpec
  /**
   * Rows to draw before the first answer, under the filter and search the address names. The app
   * passes none; the tests render a fixture with it, since a server render runs no effect.
   */
  initial?: Awaited<ReturnType<AnyAreaSpec['load']>>
}) {
  const t = useTranslations('admin.shell')
  const admin = useAdmin()
  const { version, deny } = admin
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const state = parseLedgerState(area, params)
  const specRef = useRef(spec)
  specRef.current = spec

  /** Change the address from what it says now (never from this render's copy of it). */
  const go = useCallback(
    (patch: Partial<LedgerState>, replace = false) => {
      navigate(patchedHref(area, window.location.search, patch), { replace })
    },
    [area, navigate],
  )

  // ---- The rows ---------------------------------------------------------------------------
  const [loaded, setLoaded] = useState<Loaded | null>(() =>
    initial ? { filter: state.filter, q: state.q, data: initial, failed: false } : null,
  )
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version or a retry loads again
  useEffect(() => {
    const controller = new AbortController()
    const { filter, q } = state
    specRef.current.load(filter, q, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoaded({ filter, q, data, failed: data === null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof NotAdmin) deny()
        else setLoaded({ filter, q, data: null, failed: true })
      },
    )
    return () => controller.abort()
  }, [state.filter, state.q, version, retry, deny])

  // Another filter's rows would mislead under this filter's pill: wait for this one's. The same
  // filter under a search still being typed stays, dimmed, until the new answer comes.
  const shown = loaded && loaded.filter === state.filter ? loaded : null
  const stale = shown !== null && shown.q !== state.q
  const data = shown?.data ?? null
  const rows = useMemo(() => {
    const all = data?.rows ?? []
    return state.sort ? sortRows(all, sortValueOf(spec, state.sort), state.dir) : all
  }, [data, spec, state.sort, state.dir])
  const ids = useMemo(() => rows.map((row) => row.id), [rows])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // ---- Focus and checks -------------------------------------------------------------------
  const [focusId, setFocusId] = useState<string | null>(null)
  // Where the keyboard is, as of the last key: a second j can come before React renders the first.
  const focusRef = useRef<string | null>(null)
  const focus = useCallback((id: string | null) => {
    focusRef.current = id
    setFocusId(id)
  }, [])
  /** The row a key (or the record's ↑ ↓) last moved to, until it has been scrolled into view. */
  const moved = useRef<string | null>(null)
  const openIndex = state.id ? ids.indexOf(state.id) : -1
  const focused =
    openIndex >= 0
      ? state.id
      : focusId !== null && ids.includes(focusId)
        ? focusId
        : (ids[0] ?? null)

  // Rows are checked only for a bulk action, so an area with none has no checks.
  const checkable = spec.bulk.length > 0
  const [checks, setChecks] = useState<ReadonlySet<string>>(() => new Set())
  const checkedRows = useMemo(() => rows.filter((row) => checks.has(row.id)), [rows, checks])
  const checked = useMemo(() => checkedRows.map((row) => row.id), [checkedRows])
  // A new filter or search is a new list: what was checked in the old one is not in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new filter or search only
  useEffect(() => {
    setChecks(new Set())
  }, [state.filter, state.q])
  const toggleCheck = useCallback((id: string) => {
    setChecks((now) => {
      const next = new Set(now)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ---- The open record --------------------------------------------------------------------
  const [detail, setDetail] = useState<{ id: string; value: unknown } | null>(null)
  const hasDetail = spec.loadDetail !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version loads the record again
  useEffect(() => {
    const id = state.id
    const loadDetail = specRef.current.loadDetail
    if (!id || !loadDetail) return
    const controller = new AbortController()
    loadDetail(id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setDetail({ id, value })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof NotAdmin) deny()
        else setDetail({ id, value: null })
      },
    )
    return () => controller.abort()
  }, [state.id, version, hasDetail, deny])
  const openDetail = detail && detail.id === state.id ? detail.value : null
  const openRow = openedRecord(rows, ids, state.id, openDetail, spec.rowOf).row
  const openRowRef = useRef(openRow)
  openRowRef.current = openRow

  // ---- After a list arrives: move on from an acted row, or find a record the filter hides -------
  const moving = useRef<Moving | null>(null)
  // A row an undo put back, to select again once the list that shows it arrives: the design's undo
  // puts the board back as it was, and acting had moved the selection on from that row.
  const restoring = useRef<string | null>(null)
  const restored = admin.restored
  // An undo from before this ledger opened (in another visit to the area) is not this board's.
  const seenRestore = useRef(restored?.seq ?? 0)
  useEffect(() => {
    if (!restored || restored.seq === seenRestore.current) return
    seenRestore.current = restored.seq
    const [one, ...more] = restored.area === area ? restored.ids : []
    restoring.current = one !== undefined && more.length === 0 ? one : null
  }, [restored, area])
  const [missing, setMissing] = useState<string | null>(null)
  // The record last looked for under the other filters, so one answer starts one search.
  const located = useRef<string | null>(null)
  useEffect(() => {
    if (state.id === located.current) return
    located.current = null
    setMissing(null)
  }, [state.id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per answer, or per record opened
  useEffect(() => {
    if (!shown || stale || !shown.data) return
    const after = rowsRef.current.map((row) => row.id)
    const now = parseLedgerState(area, new URLSearchParams(window.location.search))
    const back = restoring.current
    restoring.current = null
    if (back !== null && after.includes(back)) {
      moving.current = null
      focus(back)
      // An open record goes back to it; with none open, the keyboard does.
      if (now.id !== null && now.id !== back) go({ id: back }, true)
      return
    }
    const move = moving.current
    moving.current = null
    if (move) {
      const next = nextAfterAct(move.before, after, move.acted)
      if (now.id === move.acted) {
        // The design's "acting on it moves you to the next one": only when it left the list. A
        // record the list never showed (opened from its detail) has no next one, and stays.
        if (next !== move.acted && move.before.includes(move.acted)) {
          if (next) focus(next)
          go({ id: next }, true)
        }
        return
      }
      if (!now.id && focusRef.current === move.acted && next !== move.acted) focus(next)
    }
    const id = now.id
    if (!id || after.includes(id) || located.current === id) return
    // A record opened by its id alone (a link from another record, or the Overview) may sit under
    // another filter: look there, and move the filter to it.
    located.current = id
    const controller = new AbortController()
    let finished = false
    const counts = shown.data.counts as Partial<Record<AdminFilter, number>>
    void (async () => {
      for (const filter of ADMIN_FILTERS[area] as readonly AdminFilter[]) {
        if (filter === now.filter || counts[filter] === 0) continue
        const other = await specRef.current.load(filter, '', controller.signal)
        if (controller.signal.aborted) return
        if (other?.rows.some((row) => row.id === id)) {
          finished = true
          go({ filter, q: '', id }, true)
          return
        }
      }
      finished = true
      setMissing(id)
    })().catch((error: unknown) => {
      if (error instanceof NotAdmin) deny()
      else if (!controller.signal.aborted) setMissing(id)
    })
    return () => {
      controller.abort()
      // Cut short by a newer answer: that one looks again.
      if (!finished && located.current === id) located.current = null
    }
  }, [shown, state.id])

  // ---- Acting -----------------------------------------------------------------------------
  /** A row the page shows, in the list or as the open record. */
  const shownRow = useCallback((id: string) => {
    const open = openRowRef.current
    return rowsRef.current.find((r) => r.id === id) ?? (open?.id === id ? open : undefined)
  }, [])
  const titleOf = useCallback(
    (id: string) => {
      const row = shownRow(id)
      return row ? specRef.current.name.title(row) : null
    },
    [shownRow],
  )
  const doneWords = useCallback(
    (action: AdminActionName, acting: string[]) => {
      const [one, ...more] = acting
      const row = one !== undefined && more.length === 0 ? shownRow(one) : undefined
      return row ? specRef.current.actionDone?.(row, action) : undefined
    },
    [shownRow],
  )
  const { prompt, setPrompt, busy, request, run } = useAdminAct({
    area,
    titleOf,
    doneWords,
    onActed: ({ ids: acted }) => {
      const [one] = acted
      if (acted.length === 1 && one) moving.current = { acted: one, before: ids }
      // What was acted on is done with: a bulk action leaves nothing checked.
      setChecks((now) => {
        const next = new Set(now)
        for (const id of acted) next.delete(id)
        return next
      })
    },
  })
  const promptRef = useRef(prompt)
  promptRef.current = prompt

  /** A row's action from the table or a key: asked in the record, which opens for it. */
  const actOnRow = useCallback(
    (row: AdminRowBase, action: AdminActionName | undefined) => {
      if (!action || busy) return
      if (!promptFor(action)) {
        void run(action, [row.id])
        return
      }
      const now = parseLedgerState(area, new URLSearchParams(window.location.search))
      if (now.id !== row.id) go({ id: row.id })
      focus(row.id)
      setPrompt({ action, ids: [row.id], where: 'record' })
    },
    [area, busy, run, go, focus, setPrompt],
  )

  const act: Act = useCallback(
    (action, targets, args) => {
      const now = parseLedgerState(area, new URLSearchParams(window.location.search))
      return request(action, targets ?? (now.id ? [now.id] : []), 'record', args)
    },
    [area, request],
  )
  const open = useCallback(
    (to: LedgerArea, id: string) => navigate(ledgerHref(to, { id })),
    [navigate],
  )
  const answer = (args?: AdminActArgs) => {
    if (prompt) void run(prompt.action, prompt.ids, args ?? prompt.args)
  }

  // ---- Keys ---------------------------------------------------------------------------------
  const search = useRef<HTMLInputElement>(null)
  const keys = useRef({ rows, checked, checkable, actOnRow, toggleCheck })
  keys.current = { rows, checked, checkable, actOnRow, toggleCheck }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const how = keyDisposition(keyLike(e))
      if (how === 'skip') return
      if (how === 'blur') {
        if (e.target instanceof HTMLElement) e.target.blur()
        return
      }
      const { rows, checked, checkable, actOnRow, toggleCheck } = keys.current
      // The state as it is now: the address and the last key's focus, not this render's.
      const now = parseLedgerState(area, new URLSearchParams(window.location.search))
      const ids = rows.map((row) => row.id)
      const listed = now.id !== null && ids.includes(now.id)
      const command = ledgerCommand(e.key, {
        rows: rows.length,
        open: now.id !== null,
        checked: checked.length,
        prompt: promptRef.current !== null,
        checkable,
      })
      if (!command) return
      e.preventDefault()
      const at = listed
        ? now.id
        : focusRef.current !== null && ids.includes(focusRef.current)
          ? focusRef.current
          : (ids[0] ?? null)
      const row = rows.find((r) => r.id === at)
      switch (command.type) {
        case 'move': {
          const next = stepTo(ids, at, command.step)
          if (next === null) return
          if (next !== at) moved.current = next
          focus(next)
          // The record follows the keys while one is open, without a history entry per step.
          if (listed) go({ id: next }, true)
          return
        }
        case 'check':
          if (at !== null) toggleCheck(at)
          return
        case 'open':
          if (at !== null && now.id !== at) go({ id: at })
          return
        case 'act': {
          // The open record's actions, listed or not (never the focused row's under a record the
          // list does not show); with none open, the focused row's.
          const open = openRowRef.current
          const target = now.id === null || listed ? row : open?.id === now.id ? open : null
          if (target) actOnRow(target, target.actions[command.index])
          return
        }
        case 'search':
          search.current?.focus()
          return
        case 'cancelPrompt':
          setPrompt(null)
          return
        case 'close':
          if (now.id) focus(now.id)
          go({ id: null })
          return
        case 'clearChecks':
          setChecks(new Set())
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [area, go, focus, setPrompt])

  // The focused row stays in view as the keys move it, and only then: opening an area or a filter
  // focuses its first row, and scrolling to that would carry the page past its own header.
  useEffect(() => {
    const id = scrollTarget(moved.current, focused)
    if (id === null) return
    moved.current = null
    document
      .querySelector(`[data-testid="admin-row"][data-row-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  // A question about a record is about that record: stepping away takes it back. One about the
  // checked rows goes with the last check.
  useEffect(() => {
    setPrompt((now) => (now?.where === 'record' && now.ids[0] !== state.id ? null : now))
  }, [state.id, setPrompt])
  const anyChecked = checked.length > 0
  useEffect(() => {
    if (!anyChecked) setPrompt((now) => (now?.where === 'bulk' ? null : now))
  }, [anyChecked, setPrompt])

  // ---- Drawing ------------------------------------------------------------------------------
  const filterLabel = spec.filterLabel(state.filter)
  const isOpen = state.id !== null
  const grid = checkable
    ? isOpen
      ? GRID.open
      : GRID.wide
    : isOpen
      ? GRID.openNoCheck
      : GRID.wideNoCheck
  const allChecked = rows.length > 0 && checked.length === rows.length
  const Header = spec.Header
  const sortHeader = (key: SortKey, label: string, className = '') => {
    const on = state.sort === key
    return (
      <button
        type="button"
        onClick={() =>
          go(
            nextSort(parseLedgerState(area, new URLSearchParams(window.location.search)), key),
            true,
          )
        }
        className={`block max-w-full min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left ${on ? 'text-ink' : 'text-muted hover:text-ink'} ${className}`}
        aria-label={label}
        data-sort={on ? state.dir : undefined}
      >
        {on ? `${label} ${state.dir === 'asc' ? '↑' : '↓'}` : label}
      </button>
    )
  }

  return (
    <div className="flex flex-col pb-10" data-testid="admin-ledger" data-area={area}>
      <AreaHeader area={area} />
      {Header ? (
        <div className="mt-[22px]">
          <Rendered render={Header} props={{}} />
        </div>
      ) : null}
      <FilterPills
        filters={ADMIN_FILTERS[area] as readonly AdminFilter[]}
        active={state.filter}
        label={(filter) => spec.filterLabel(filter)}
        counts={(loaded?.data?.counts as Partial<Record<AdminFilter, number>> | undefined) ?? null}
        onChoose={(filter) => {
          focus(null)
          go({ filter, id: null })
        }}
      />
      <div className="mt-3.5 flex flex-wrap items-center gap-3.5">
        <SearchBox
          value={state.q}
          hint={spec.searchHint}
          inputRef={search}
          onSearch={(q) => go({ q, id: null }, true)}
        />
        <span className="min-w-0 text-[13px] text-muted">
          {data
            ? state.q
              ? t('ledger.matches', { n: rows.length, filter: filterLabel })
              : t('ledger.count', { n: rows.length, filter: filterLabel })
            : null}
        </span>
        {spec.create && spec.create.length > 0 ? (
          <div className="flex flex-wrap gap-2 md:ml-auto">
            {spec.create.map((action) => (
              <ActionButton
                key={action}
                look="ghost"
                disabled={busy}
                onClick={() => request(action, [], 'create')}
                data-testid="admin-create"
                data-action={action}
              >
                {t(`actions.${action}.label`)}
              </ActionButton>
            ))}
          </div>
        ) : null}
      </div>
      {prompt?.where === 'create' ? (
        <div className="mt-3 max-w-md rounded-xl border border-line bg-surface p-4">
          <ActionPrompt
            prompt={prompt}
            busy={busy}
            onAnswer={answer}
            onCancel={() => setPrompt(null)}
          />
        </div>
      ) : null}
      <div
        className={`mt-3 grid items-start gap-5 ${isOpen ? 'lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_430px]' : ''}`}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <div
            className={`overflow-hidden rounded-xl border border-line bg-paper ${stale ? 'opacity-60' : ''}`}
          >
            <div
              className={`admin-side grid items-center gap-3 px-3.5 py-[9px] text-[11.5px] font-semibold tracking-[.06em] text-muted uppercase ${grid}`}
            >
              {checkable ? (
                <CheckBox
                  checked={allChecked}
                  mixed={!allChecked && checked.length > 0}
                  label={t('ledger.selectAll')}
                  onToggle={() => setChecks(allChecked ? new Set() : new Set(ids))}
                />
              ) : null}
              {sortHeader('name', spec.name.label)}
              {isOpen
                ? null
                : spec.columns.map((column, i) => (
                    <span key={column.label} className="hidden min-w-0 lg:block">
                      {sortHeader(`c${i + 1}` as SortKey, column.label)}
                    </span>
                  ))}
              {sortHeader('status', t('ledger.status'))}
              {isOpen ? null : <span className="hidden xl:block" />}
            </div>
            {rows.map((row) => {
              const on = row.id === state.id
              const isFocused = row.id === focused
              const status = spec.status(row)
              const primary = row.actions[0]
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the name's link and the keys reach the same record
                // biome-ignore lint/a11y/useKeyWithClickEvents: as above
                <div
                  key={row.id}
                  onClick={(e) => {
                    if ((e.target as Element).closest('a, button, label, input')) return
                    focus(row.id)
                    go({ id: on ? null : row.id })
                  }}
                  className={`grid cursor-pointer items-center gap-3 border-t border-line px-3.5 py-[11px] text-[13.5px] hover:bg-hover ${grid} ${on ? 'bg-hover' : ''} ${isFocused ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]' : ''}`}
                  data-testid="admin-row"
                  data-row-id={row.id}
                  data-focus={isFocused ? 'true' : 'false'}
                  data-open={on ? 'true' : 'false'}
                >
                  {checkable ? (
                    <CheckBox
                      checked={checks.has(row.id)}
                      label={t('ledger.select')}
                      onToggle={() => {
                        focus(row.id)
                        toggleCheck(row.id)
                      }}
                    />
                  ) : null}
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex shrink-0">{spec.name.tile(row)}</span>
                    <div className="min-w-0">
                      <Link
                        to={ledgerHref(area, { ...state, id: on ? null : row.id })}
                        onClick={() => focus(row.id)}
                        className="block truncate font-medium text-ink hover:no-underline"
                        aria-current={on ? 'true' : undefined}
                      >
                        {spec.name.title(row)}
                      </Link>
                      <div className="truncate text-[12px] text-muted">{spec.name.sub(row)}</div>
                    </div>
                  </div>
                  {isOpen
                    ? null
                    : spec.columns.map((column) => (
                        <span
                          key={column.label}
                          className="hidden truncate text-ink-2 tabular-nums lg:block"
                        >
                          {column.text(row)}
                        </span>
                      ))}
                  <span className="flex min-w-0 justify-start">
                    <StatusPill tone={status.tone} label={status.label} />
                  </span>
                  {isOpen ? null : (
                    <span className="hidden min-w-0 justify-end xl:flex">
                      {primary ? (
                        <ActionButton
                          look={actionLook(primary, 1) === 'danger' ? 'danger' : 'ghost'}
                          size="sm"
                          disabled={busy}
                          onClick={() => actOnRow(row, primary)}
                          data-testid="admin-row-action"
                          data-action={primary}
                        >
                          <span className="truncate">
                            {spec.actionLabel?.(row, primary) ?? t(`actions.${primary}.short`)}
                          </span>
                        </ActionButton>
                      ) : null}
                    </span>
                  )}
                </div>
              )
            })}
            <TableState
              spec={spec}
              shown={shown}
              rows={rows.length}
              filter={state.filter}
              first={state.filter === ADMIN_FILTERS[area][0]}
              q={state.q}
              onRetry={() => setRetry((n) => n + 1)}
            />
          </div>
          {data?.truncated ? (
            <p className="m-0 px-0.5 text-[12.5px] text-muted">
              {t('ledger.truncated', { n: ADMIN_LIST_LIMIT })}
            </p>
          ) : null}
          <KeyLegend />
        </div>
        {isOpen ? (
          <RecordPanel
            spec={spec}
            row={openRow}
            detail={openDetail}
            index={openIndex}
            total={rows.length}
            missing={missing !== null && missing === state.id}
            prompt={prompt?.where === 'record' ? prompt : null}
            busy={busy}
            onStep={(step) => {
              const now = parseLedgerState(area, new URLSearchParams(window.location.search))
              const next = stepTo(ids, now.id, step)
              if (next === null) return
              if (next !== now.id) moved.current = next
              focus(next)
              go({ id: next }, true)
            }}
            onClose={() => {
              if (state.id) focus(state.id)
              go({ id: null })
            }}
            onAction={(action) => {
              if (openRow) actOnRow(openRow, action)
            }}
            onAnswer={answer}
            onCancel={() => setPrompt(null)}
            act={act}
            open={open}
          />
        ) : null}
      </div>
      {checked.length > 0 ? (
        <BulkBar
          n={checked.length}
          actions={bulkOffer(spec.bulk, checkedRows)}
          busy={busy}
          prompt={prompt?.where === 'bulk' ? prompt : null}
          onAct={(action) => request(action, bulkTargets(action, checkedRows), 'bulk')}
          onAnswer={answer}
          onCancel={() => setPrompt(null)}
          onClear={() => setChecks(new Set())}
        />
      ) : null}
    </div>
  )
}

/** Under the rows: loading, a failure, or what an empty list means here. */
function TableState({
  spec,
  shown,
  rows,
  filter,
  first,
  q,
  onRetry,
}: {
  spec: AnyAreaSpec
  shown: Loaded | null
  rows: number
  filter: AdminFilter
  /** The area's first filter, which a queue area's queue is. */
  first: boolean
  q: string
  onRetry: () => void
}) {
  const t = useTranslations('admin.shell')
  if (!shown)
    return <p className="m-0 border-t border-line px-7 py-11 text-muted">{t('ledger.loading')}</p>
  if (shown.failed) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-7 py-8 text-ink-2">
        {t('ledger.loadFailed')}
        <ActionButton look="ghost" onClick={onRetry}>
          {t('ledger.retry')}
        </ActionButton>
      </div>
    )
  }
  if (rows > 0) return null
  const label = spec.filterLabel(filter)
  const [title, body] = q
    ? [t('ledger.noMatches'), t('ledger.noMatchesBody', { filter: label, q })]
    : spec.queue && first
      ? [t('ledger.queueClear'), t('ledger.queueClearBody', { filter: label })]
      : [t('ledger.nothingHere'), t('ledger.nothingHereBody', { filter: label })]
  return (
    <div
      className="flex flex-col gap-1.5 border-t border-line px-7 py-11"
      data-testid="admin-empty"
    >
      <div className="font-serif text-[30px] leading-tight">{title}</div>
      <div className="text-ink-2">{body}</div>
    </div>
  )
}

/** The sticky bar while rows are checked: how many, what can be done to all of them, Clear. */
function BulkBar({
  n,
  actions,
  busy,
  prompt,
  onAct,
  onAnswer,
  onCancel,
  onClear,
}: {
  n: number
  actions: readonly AdminActionName[]
  busy: boolean
  prompt: Prompt | null
  onAct: (action: AdminActionName) => void
  onAnswer: (args?: AdminActArgs) => void
  onCancel: () => void
  onClear: () => void
}) {
  const t = useTranslations('admin.shell')
  return (
    <div
      className="pointer-events-none sticky bottom-[18px] z-10 -mt-7 flex flex-col items-center gap-2"
      data-testid="admin-bulk"
    >
      {prompt ? (
        <div className="pointer-events-auto w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-lg">
          <ActionPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onCancel={onCancel} />
        </div>
      ) : null}
      <div className="pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto rounded-full bg-ink py-1.5 pr-1.5 pl-[18px] text-[13.5px] text-paper shadow-lg">
        <span className="mr-1.5 shrink-0 font-semibold whitespace-nowrap">
          {t('ledger.selected', { n })}
        </span>
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => onAct(action)}
            className="shrink-0 cursor-pointer rounded-full border border-muted bg-transparent px-[13px] py-[5px] text-[13px] font-semibold whitespace-nowrap text-paper disabled:opacity-60"
            data-testid="admin-bulk-action"
            data-action={action}
          >
            {t(`actions.${action}.label`)}
          </button>
        ))}
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 cursor-pointer border-0 bg-transparent px-2.5 py-[5px] text-[13px] text-paper opacity-75 hover:opacity-100"
        >
          {t('ledger.clear')}
        </button>
      </div>
    </div>
  )
}
