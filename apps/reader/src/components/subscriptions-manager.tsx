/**
 * Settings › Subscriptions from `lg` up (ADR 0049, Tela Lists "Manage folders"): one card with
 * the places a blog can be in down its left (All blogs, Not in a folder, each folder), and the
 * blogs of the place chosen on its right, filtered by name or address and sorted three ways, each
 * with its folder and when it last posted. A blog dragged onto a place moves there, and its folder
 * button moves it from the keyboard; Select turns on tick boxes, for moving or leaving several at
 * once. The card grows with its rows while its pane and toolbar stay in view (`sticky`), so the
 * places to drop on are always there. Changes are the page's (`ManagerActions`); this holds only
 * what is being looked at.
 */
import { MAX_FOLDERS } from '@tela/shared'
import {
  type DragEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslations } from 'use-intl'
import { displayHost } from '../lib/format'
import {
  clickRow,
  compareBy,
  hiddenTicks,
  matcher,
  NO_TICKS,
  QUIET_AFTER_MS,
  SORTS,
  type SortKey,
  standing,
  type Ticks,
  tickedState,
  toggleAll,
  untick,
} from '../lib/subscriptions'
import { showToast } from '../lib/toasts'
import { useDismiss } from '../lib/use-dismiss'
import {
  BlogName,
  type Folder,
  type ManagedRow,
  MenuItem,
  MoveOptions,
  menuKeys,
  NewFolderForm,
  PLUS,
  RenameForm,
  rowMeta,
} from './folders-manage'
import { CHECK, CHEVRON_DOWN, Glyph } from './glyph'
import { SiteAvatar } from './site-avatar'

/** What the manager changes, made by the page. */
export type ManagerActions = {
  move: (feedIds: readonly number[], folderId: string | null) => void
  unsubscribe: (feedIds: readonly number[]) => void
  /** Make a folder of this name with these blogs in it, and say its id. */
  create: (name: string, feedIds: readonly number[]) => string | null
  rename: (folder: Folder, name: string) => void
  remove: (folder: Folder) => void
}

/** Where the manager is looking: every blog, those in no folder, or a folder's, by its id. */
type Place = { kind: 'all' } | { kind: 'none' } | { kind: 'folder'; id: string }
const ALL: Place = { kind: 'all' }
const NONE: Place = { kind: 'none' }

/** A place as a drop target is keyed: the folder's id, or '' for none. */
const keyOfFolder = (folderId: string | null) => folderId ?? ''

/** Only a row of this page is dragged here: a file or a link from elsewhere is not a blog. */
const DRAG_TYPE = 'application/x-tela-feeds'

/** Every row's columns, the heads' too: picture, blog, folder, latest post. */
const COLUMNS =
  'grid min-w-0 flex-1 grid-cols-[28px_minmax(120px,1fr)_minmax(88px,136px)_minmax(0,92px)] items-center gap-3'

/** A folder, in the pane. */
const FOLDER_ICON = (
  <path
    d="M2.5 4.75a1.25 1.25 0 0 1 1.25-1.25h2.6l1.4 1.5h4.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25h-8.5a1.25 1.25 0 0 1-1.25-1.25z"
    strokeLinejoin="round"
  />
)
/** Lines: every blog. */
const ALL_ICON = <path d="M3 4h10M3 8h10M3 12h10" />
/** A tray: the blogs in no folder. */
const TRAY_ICON = (
  <g strokeLinejoin="round">
    <path d="M2.5 9h3l1 1.75h3l1-1.75h3" />
    <path d="M4.25 3.5h7.5l1.75 5.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9z" />
  </g>
)
const SEARCH = (
  <g strokeLinejoin="round">
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </g>
)

/**
 * Blogs dragged onto a place move there (native drag and drop). What is dragged is kept in a ref
 * as well as in state, since a drop reads it when it lands and a render may not have caught up
 * with the drag's start; and which folder each blog is in is asked when it is needed, of the
 * device's rows as they are then (`folderOf`), so a place they are all in already neither lights
 * up nor takes them. The image under the pointer is a pill naming what moves.
 */
function useBlogDrag(
  folderOf: (feedId: number) => string | null,
  move: (feedIds: readonly number[], folderId: string | null) => void,
) {
  const dragged = useRef<readonly number[] | null>(null)
  const [dragging, setDragging] = useState<readonly number[] | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const end = () => {
    dragged.current = null
    setDragging(null)
    setOver(null)
  }
  /** The blogs being dragged that the place `key` would move. */
  const movable = (key: string) =>
    (dragged.current ?? []).filter((id) => keyOfFolder(folderOf(id)) !== key)
  return {
    dragging,
    over,
    row: (ids: () => readonly number[], label: () => string) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        const moving = ids()
        e.dataTransfer.effectAllowed = 'move'
        // Firefox starts no drag without data.
        e.dataTransfer.setData(DRAG_TYPE, moving.join(','))
        const pill = document.createElement('div')
        pill.textContent = label()
        pill.className =
          'fixed -top-[100px] left-0 rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-paper'
        document.body.appendChild(pill)
        e.dataTransfer.setDragImage(pill, 14, 16)
        setTimeout(() => pill.remove(), 0)
        dragged.current = moving
        setDragging(moving)
      },
      onDragEnd: end,
    }),
    target: (folderId: string | null) => {
      const key = keyOfFolder(folderId)
      return {
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (movable(key).length === 0) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setOver(key)
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          // Into one of its own parts is not out of it. Safari names no element, and the next
          // dragover lights it again.
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
          setOver((o) => (o === key ? null : o))
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
          const moving = movable(key)
          if (moving.length === 0) return
          e.preventDefault()
          move(moving, folderId)
          end()
        },
      }
    },
  }
}

export function SubscriptionsManager({
  rows,
  folders,
  known,
  canMake,
  folderOf,
  activity,
  now,
  actions,
}: {
  /** Every blog followed, by name. */
  rows: readonly ManagedRow[]
  /** The member's folders, by name. */
  folders: readonly Folder[]
  /** The names a new folder may not take (`knownFolders`). */
  known: readonly Folder[]
  canMake: boolean
  /** The folder a blog is in now, of the device's rows as they are when asked. */
  folderOf: (feedId: number) => string | null
  activity: (row: ManagedRow) => string
  now: number
  actions: ManagerActions
}) {
  const t = useTranslations('settings.folders')
  const ts = useTranslations('settings')
  const [place, setPlace] = useState<Place>(ALL)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [selecting, setSelecting] = useState(false)
  const [ticks, setTicks] = useState<Ticks>(NO_TICKS)
  // New folder's form: for the blogs ticked when it was asked for from Move to, or for none.
  const [creating, setCreating] = useState<readonly number[] | null>(null)
  const [renaming, setRenaming] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const plus = useRef<HTMLButtonElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const unfiledPlace = useRef<HTMLButtonElement>(null)
  const renameButton = useRef<HTMLButtonElement>(null)
  const limitId = useId()
  const titleId = useId()
  // Where focus goes once the control that had it has gone, at the next render.
  const refocus = useRef<(() => HTMLElement | null) | null>(null)
  useLayoutEffect(() => {
    const to = refocus.current
    if (to === null) return
    refocus.current = null
    to()?.focus()
  })

  // A folder deleted, here or on another device, leaves its blogs in none: that is where to look.
  const folder = place.kind === 'folder' ? folders.find((f) => f.id === place.id) : undefined
  const at: Place = folder ? place : place.kind === 'all' ? ALL : NONE
  const pool = rows.filter((r) =>
    at.kind === 'all' ? true : at.kind === 'none' ? r.folderId === null : r.folderId === at.id,
  )
  const matches = matcher(query)
  const shown = pool
    .filter((r) => matches([r.title, r.site ? displayHost(r.site.homeUrl) : null, r.feedUrl]))
    .sort(compareBy(sort))
  const shownIds = shown.map((r) => r.feedId)
  const picked = standing(ticks.picked, new Set(pool.map((r) => r.feedId)))
  const hidden = hiddenTicks(picked, shownIds)
  const pickedLabel =
    hidden > 0
      ? t('selectedHidden', { n: picked.length, hidden })
      : t('selected', { n: picked.length })

  const go = (to: Place) => {
    setPlace(to)
    setTicks(NO_TICKS)
    setQuery('')
    setRenaming(false)
  }
  const leaveSelect = () => {
    setSelecting(false)
    setTicks(NO_TICKS)
  }
  // Esc leaves Select mode, once nothing nearer has taken it: a menu (`useDismiss`), a form, or
  // the filter, which clears first.
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setSelecting(false)
      setTicks(NO_TICKS)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selecting])

  // What moved is unticked, and nothing else: one unticked row moved by its folder button, or
  // dragged, leaves the others ticked; a bulk move or a dragged selection unticks them all.
  const move = (ids: readonly number[], folderId: string | null) => {
    actions.move(ids, folderId)
    setTicks((k) => untick(k, ids))
  }
  const drag = useBlogDrag(folderOf, move)
  const nameOf = (ids: readonly number[]) =>
    ids.length === 1
      ? (rows.find((r) => r.feedId === ids[0])?.title ?? '')
      : t('blogs', { n: ids.length })

  const title = folder ? folder.name : at.kind === 'none' ? t('unfiled') : t('allBlogs')
  const count = query.trim()
    ? t('countOf', { shown: shown.length, n: pool.length })
    : t('blogs', { n: pool.length })
  const empty =
    shown.length > 0
      ? null
      : query.trim()
        ? t('noMatch', { query: query.trim() })
        : rows.length === 0
          ? ts('noSubscriptions')
          : folder
            ? t('emptyFolder', { name: folder.name })
            : t('allFiled')

  const placeButton = (
    to: Place,
    label: string,
    icon: ReactNode,
    n: number,
    droppable: boolean,
  ) => {
    const key = to.kind === 'folder' ? to.id : to.kind === 'none' ? '' : null
    const current =
      to.kind === at.kind && (to.kind !== 'folder' || (at.kind === 'folder' && at.id === to.id))
    const hot = droppable && drag.over === key
    const ring = hot
      ? 'bg-accent/[.18] shadow-[inset_0_0_0_1.5px_var(--color-accent)]'
      : droppable && drag.dragging
        ? 'shadow-[inset_0_0_0_1px_var(--color-thumb)]'
        : ''
    return (
      <button
        key={key ?? 'all'}
        ref={to.kind === 'none' ? unfiledPlace : undefined}
        type="button"
        aria-current={current ? 'true' : undefined}
        onClick={() => go(to)}
        {...(droppable && key !== null ? drag.target(key === '' ? null : key) : {})}
        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ink transition-colors hover:bg-hover ${current && !hot ? 'bg-hover' : ''} ${to.kind === 'folder' ? '' : 'font-medium'} ${ring}`}
        data-testid="place"
        data-place={key ?? 'all'}
        data-over={hot ? 1 : undefined}
      >
        <Glyph size={15} strokeWidth={1.5} className="shrink-0 text-muted">
          {icon}
        </Glyph>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-[12px] font-normal text-muted">{n}</span>
      </button>
    )
  }

  const created = (name: string) => {
    const ids = creating ?? []
    const id = actions.create(name, ids)
    setCreating(null)
    if (id === null) return
    if (ids.length > 0) {
      setPlace({ kind: 'folder', id })
      setTicks(NO_TICKS)
      setQuery('')
      showToast(t('createdWith', { name, n: ids.length }))
    } else {
      showToast(t('createdEmpty', { name }))
    }
    refocus.current = () =>
      document.querySelector<HTMLElement>(`[data-testid="place"][data-place="${CSS.escape(id)}"]`)
  }

  return (
    <div
      className="grid grid-cols-[clamp(176px,18vw,236px)_minmax(0,1fr)] rounded-[14px] border border-line bg-surface"
      data-testid="subscriptions-manager"
    >
      <div className="rounded-l-[13px] border-r border-line bg-paper">
        <div className="sticky top-14 flex max-h-[calc(100dvh-3.5rem)] flex-col">
          <nav
            aria-label={t('places')}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2.5"
          >
            {placeButton(ALL, t('allBlogs'), ALL_ICON, rows.length, false)}
            {placeButton(
              NONE,
              t('unfiled'),
              TRAY_ICON,
              rows.filter((r) => r.folderId === null).length,
              true,
            )}
            <div className="flex items-center justify-between pt-4 pr-1 pb-1.5 pl-2.5">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                {t('folders')}
              </span>
              <button
                ref={plus}
                type="button"
                disabled={!canMake}
                aria-describedby={canMake ? undefined : limitId}
                aria-label={t('new')}
                title={t('new')}
                onClick={() => setCreating([])}
                className="flex rounded-md px-[7px] py-[5px] text-muted hover:bg-hover hover:text-ink disabled:opacity-60"
                data-testid="new-folder"
              >
                <Glyph size={15}>{PLUS}</Glyph>
              </button>
            </div>
            {canMake ? null : (
              <p
                id={limitId}
                className="m-0 px-2.5 pb-1.5 text-[12px] text-muted"
                data-testid="new-folder-limit"
              >
                {t('limit', { max: MAX_FOLDERS })}
              </p>
            )}
            {creating !== null && canMake ? (
              <NewFolderForm
                folders={known}
                variant="pane"
                label={creating.length > 0 ? t('newWith', { n: creating.length }) : undefined}
                onCreate={created}
                onCancel={() => {
                  setCreating(null)
                  refocus.current = () => plus.current
                }}
              />
            ) : null}
            {folders.map((f) =>
              placeButton(
                { kind: 'folder', id: f.id },
                f.name,
                FOLDER_ICON,
                rows.filter((r) => r.folderId === f.id).length,
                true,
              ),
            )}
          </nav>
          <p className="m-0 border-t border-line px-4 pt-3 pb-3.5 text-[12px] leading-normal text-muted">
            {t('paneHint')} {t('private')}
          </p>
        </div>
      </div>

      <section aria-labelledby={titleId} className="min-w-0">
        <div className="sticky top-14 z-[2] rounded-tr-[13px] bg-surface">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-line px-[18px] py-3.5">
            {renaming && folder ? (
              <RenameForm
                folder={folder}
                folders={known}
                inToolbar
                onSave={(name) => {
                  if (name !== folder.name) actions.rename(folder, name)
                  setRenaming(false)
                  refocus.current = () => renameButton.current
                }}
                onCancel={() => {
                  setRenaming(false)
                  refocus.current = () => renameButton.current
                }}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-x-3 gap-y-1">
                <div className="flex min-w-0 items-baseline gap-2.5">
                  <h3
                    id={titleId}
                    ref={heading}
                    tabIndex={-1}
                    className="m-0 truncate font-serif text-[22px] font-medium outline-none"
                    data-testid="manager-title"
                  >
                    {title}
                  </h3>
                  <span
                    className="shrink-0 text-[13px] whitespace-nowrap text-muted"
                    data-testid="manager-count"
                  >
                    {count}
                  </span>
                </div>
                {folder ? (
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      ref={renameButton}
                      type="button"
                      onClick={() => setRenaming(true)}
                      className="rounded-md px-[9px] py-[5px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-ink"
                      data-testid="folder-rename"
                    >
                      {t('rename')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        actions.remove(folder)
                        go(NONE)
                        refocus.current = () => unfiledPlace.current
                      }}
                      className="rounded-md px-[9px] py-[5px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-danger"
                      data-testid="folder-delete"
                    >
                      {t('delete')}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
            <div className="ml-auto flex min-w-0 flex-[1_1_360px] items-center justify-end gap-2">
              <label className="flex h-[34px] min-w-[140px] flex-[0_1_230px] items-center gap-2 rounded-full border border-line bg-paper px-3 text-muted focus-within:border-muted">
                <Glyph size={13} className="shrink-0">
                  {SEARCH}
                </Glyph>
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setTicks((k) => ({ picked: k.picked, anchor: null }))
                  }}
                  onKeyDown={(e) => {
                    // Esc clears the filter first; an empty one lets Esc leave Select mode.
                    if (e.key === 'Escape' && query !== '') {
                      e.preventDefault()
                      setQuery('')
                    }
                  }}
                  placeholder={t('filter')}
                  aria-label={t('filterLabel')}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-ink outline-none placeholder:text-muted"
                  data-testid="subscriptions-filter"
                />
              </label>
              <SortMenu
                sort={sort}
                onSort={(s) => {
                  setSort(s)
                  setTicks((k) => ({ picked: k.picked, anchor: null }))
                }}
              />
              <button
                type="button"
                aria-pressed={selecting}
                disabled={!selecting && rows.length === 0}
                onClick={() => (selecting ? leaveSelect() : setSelecting(true))}
                className="shrink-0 rounded-full border border-thumb px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-ink hover:border-ink disabled:opacity-60"
                data-testid="select-toggle"
              >
                {selecting ? t('done') : t('select')}
              </button>
            </div>
          </div>
          <div className="flex min-h-11 items-center gap-3 border-b border-line px-[18px]">
            {selecting ? (
              <SelectAll
                input={selectAll}
                state={tickedState(new Set(picked), shownIds)}
                onToggle={() => setTicks(toggleAll(new Set(picked), shownIds))}
              />
            ) : null}
            {picked.length > 0 ? (
              <BulkBar
                label={pickedLabel}
                folders={folders}
                canMake={canMake}
                onMove={(folderId) => {
                  move(picked, folderId)
                  refocus.current = () => selectAll.current
                }}
                onNewFolder={() => setCreating(picked)}
                onUnsubscribe={() => {
                  actions.unsubscribe(picked)
                  setTicks(NO_TICKS)
                  refocus.current = () => selectAll.current
                }}
                onClear={() => {
                  setTicks(NO_TICKS)
                  refocus.current = () => selectAll.current
                }}
              />
            ) : (
              <div
                aria-hidden="true"
                className={`${COLUMNS} text-[11px] font-semibold tracking-[0.08em] text-muted uppercase`}
              >
                <span />
                <span>{t('columns.blog')}</span>
                <span>{t('columns.folder')}</span>
                <span className="truncate">{t('columns.latest')}</span>
              </div>
            )}
          </div>
          <span className="sr-only" aria-live="polite">
            {selecting && picked.length > 0 ? pickedLabel : ''}
          </span>
        </div>

        {shown.length > 0 ? (
          <ul className="m-0 list-none p-0" data-testid="settings-subscriptions">
            {shown.map((row) => {
              const on = selecting && ticks.picked.has(row.feedId)
              const dragged = drag.dragging?.includes(row.feedId) ?? false
              const quiet = row.dead || row.latest === null || now - row.latest > QUIET_AFTER_MS
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: in Select mode its tick box takes the keys, and Space's click comes here
                <li
                  key={row.feedId}
                  {...drag.row(
                    () => (on ? picked : [row.feedId]),
                    () => nameOf(on ? picked : [row.feedId]),
                  )}
                  onClick={
                    selecting
                      ? (e) => setTicks(clickRow(ticks, shownIds, row.feedId, e.shiftKey))
                      : undefined
                  }
                  className={`flex items-center gap-3 border-b border-line px-[18px] py-[9px] select-none last:rounded-br-[13px] last:border-b-0 ${on ? 'bg-accent/[.11]' : ''} ${selecting ? 'cursor-pointer' : 'cursor-grab'} ${dragged ? 'opacity-45' : ''}`}
                  data-testid="settings-subscription"
                  data-feed-id={row.feedId}
                  data-ticked={on ? 1 : undefined}
                >
                  {selecting ? (
                    <input
                      type="checkbox"
                      checked={on}
                      // Its own click ticks it, with Shift for a run, and goes no further: the
                      // row's click is for a click anywhere else on it.
                      onChange={(e) =>
                        setTicks(
                          clickRow(
                            ticks,
                            shownIds,
                            row.feedId,
                            (e.nativeEvent as MouseEvent).shiftKey === true,
                          ),
                        )
                      }
                      onClick={(e) => e.stopPropagation()}
                      aria-label={row.title}
                      className="size-4 shrink-0 cursor-pointer accent-ink"
                      data-testid="subscription-tick"
                    />
                  ) : null}
                  <div className={COLUMNS}>
                    <SiteAvatar
                      id={row.site?.id ?? row.feedId}
                      title={row.title}
                      faviconKey={row.site?.faviconKey ?? null}
                      size={28}
                    />
                    <BlogName row={row} meta={rowMeta(row, '')} link={!selecting} />
                    <FolderChip
                      row={row}
                      folders={folders}
                      onMove={(folderId) => {
                        move([row.feedId], folderId)
                        // Still listed here (All blogs), focus stays with it; moved away, it goes
                        // to the list's heading.
                        refocus.current = () =>
                          document.querySelector<HTMLElement>(
                            `[data-testid="settings-subscription"][data-feed-id="${row.feedId}"] [data-testid="move-to"]`,
                          ) ?? heading.current
                      }}
                      onUnsubscribe={() => {
                        actions.unsubscribe([row.feedId])
                        refocus.current = () => heading.current
                      }}
                    />
                    <span
                      className={`truncate text-[12.5px] whitespace-nowrap ${quiet ? 'text-muted' : 'text-ink-2'}`}
                      data-testid="latest-post"
                    >
                      {activity(row)}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p
            className="mx-auto my-0 max-w-[380px] px-6 py-14 text-center text-[13.5px] leading-normal text-muted"
            data-testid="manager-empty"
          >
            {empty}
          </p>
        )}
      </section>
    </div>
  )
}

/** The box over the tick boxes: none, some (`mixed`), or every row shown. */
function SelectAll({
  input,
  state,
  onToggle,
}: {
  input: RefObject<HTMLInputElement | null>
  state: 'none' | 'some' | 'all'
  onToggle: () => void
}) {
  const t = useTranslations('settings.folders')
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = state === 'some'
  })
  return (
    <input
      ref={input}
      type="checkbox"
      checked={state === 'all'}
      onChange={onToggle}
      aria-label={t('selectAll')}
      className="size-4 shrink-0 cursor-pointer accent-ink"
      data-testid="select-all"
    />
  )
}

/** "3 selected", then Move to, Unsubscribe and Clear: what the ticked blogs can do. */
function BulkBar({
  label,
  folders,
  canMake,
  onMove,
  onNewFolder,
  onUnsubscribe,
  onClear,
}: {
  label: string
  folders: readonly Folder[]
  canMake: boolean
  onMove: (folderId: string | null) => void
  onNewFolder: () => void
  onUnsubscribe: () => void
  onClear: () => void
}) {
  const t = useTranslations('settings.folders')
  const ts = useTranslations('settings')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const buttonId = useId()
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  const quiet =
    'rounded-full px-2.5 py-[5px] text-[12.5px] whitespace-nowrap hover:bg-hover hover:text-ink'
  return (
    <div
      className="flex min-w-0 flex-1 animate-fade flex-wrap items-center gap-1.5"
      data-testid="bulk-bar"
    >
      <span className="mr-1.5 text-[13px] font-semibold" data-testid="bulk-count">
        {label}
      </span>
      <div ref={box} className="relative">
        <button
          ref={button}
          id={buttonId}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-full bg-ink py-[5px] pr-2.5 pl-3 text-[12.5px] font-medium text-paper hover:brightness-125"
          data-testid="bulk-move"
        >
          {t('moveTo')}
          <Glyph size={12}>{CHEVRON_DOWN}</Glyph>
        </button>
        {open ? (
          <div className="absolute top-[calc(100%+6px)] left-0 z-[8] flex max-h-[min(360px,60vh)] min-w-[210px] animate-fade flex-col overflow-y-auto rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]">
            <MoveOptions
              folders={folders}
              current={undefined}
              heading={false}
              labelledBy={buttonId}
              onChoose={(folderId) => {
                setOpen(false)
                onMove(folderId)
              }}
              extra={
                canMake ? (
                  <MenuItem
                    onClick={() => {
                      setOpen(false)
                      onNewFolder()
                    }}
                    testId="bulk-new-folder"
                  >
                    {t('newWithThese')}
                  </MenuItem>
                ) : null
              }
            />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onUnsubscribe}
        className={`${quiet} text-ink-2`}
        data-testid="bulk-unsubscribe"
      >
        {ts('unsubscribe')}
      </button>
      <button
        type="button"
        onClick={onClear}
        className={`${quiet} text-muted`}
        data-testid="bulk-clear"
      >
        {t('clear')}
      </button>
    </div>
  )
}

/** The order the blogs are listed in: A to Z, Recently posted, Quiet longest. */
function SortMenu({ sort, onSort }: { sort: SortKey; onSort: (sort: SortKey) => void }) {
  const t = useTranslations('settings.folders.sort')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const buttonId = useId()
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [open])
  return (
    <div ref={box} className="relative shrink-0">
      <button
        ref={button}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('label', { order: t(sort) })}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-[7px] text-[13px] whitespace-nowrap text-ink-2 hover:bg-hover hover:text-ink"
        data-testid="subscriptions-sort"
      >
        {t(sort)}
        <Glyph size={12}>{CHEVRON_DOWN}</Glyph>
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-labelledby={buttonId}
          onKeyDown={menuKeys}
          className="absolute top-[calc(100%+6px)] right-0 z-[8] flex min-w-[180px] animate-fade flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]"
        >
          {SORTS.map((s) => {
            const on = s === sort
            return (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => {
                  setOpen(false)
                  onSort(s)
                  button.current?.focus()
                }}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-hover ${on ? 'bg-hover' : ''}`}
                data-testid="sort-option"
                data-sort={s}
              >
                <span className="flex-1">{t(s)}</span>
                {on ? (
                  <Glyph size={12} strokeWidth={1.8}>
                    {CHECK}
                  </Glyph>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A row's folder, as a button that opens Move to: its folders, No folder, and, under a rule,
 * Unsubscribe. A click on it is its own, never the row's tick.
 */
function FolderChip({
  row,
  folders,
  onMove,
  onUnsubscribe,
}: {
  row: ManagedRow
  folders: readonly Folder[]
  onMove: (folderId: string | null) => void
  onUnsubscribe: () => void
}) {
  const t = useTranslations('settings.folders')
  const ts = useTranslations('settings')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  const name = folders.find((f) => f.id === row.folderId)?.name ?? t('none')
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the click from the row's tick
    // biome-ignore lint/a11y/useKeyWithClickEvents: the button inside takes the keys
    <div ref={box} onClick={(e) => e.stopPropagation()} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('folderOf', { blog: row.title, folder: name })}
        onClick={() => setOpen((o) => !o)}
        className={`flex max-w-full items-center gap-1.5 rounded-[7px] border border-line bg-surface py-1 pr-2 pl-2.5 text-[12.5px] hover:border-thumb hover:text-ink ${row.folderId === null ? 'text-muted' : 'text-ink-2'}`}
        data-testid="move-to"
      >
        <span className="truncate">{name}</span>
        <Glyph size={11} className="shrink-0">
          {CHEVRON_DOWN}
        </Glyph>
      </button>
      {open ? (
        <div className="absolute top-[calc(100%+6px)] right-0 z-[7] flex max-h-[min(360px,60vh)] min-w-[200px] animate-fade flex-col overflow-y-auto rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]">
          <MoveOptions
            folders={folders}
            current={row.folderId}
            onChoose={(folderId) => {
              setOpen(false)
              if (folderId === row.folderId) button.current?.focus()
              else onMove(folderId)
            }}
            extra={
              <MenuItem
                muted
                onClick={() => {
                  setOpen(false)
                  onUnsubscribe()
                }}
                testId="row-unsubscribe"
              >
                {ts('unsubscribe')}
              </MenuItem>
            }
          />
        </div>
      ) : null}
    </div>
  )
}
