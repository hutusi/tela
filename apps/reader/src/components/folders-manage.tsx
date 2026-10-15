/**
 * Settings › Subscriptions in folders (ADR 0048, Tela Lists): a section per folder, by name, each
 * with its blogs by title, then the blogs in none. Each row has a folder button that opens Move to,
 * a menu from `md` up and a sheet below it (screen 27). A folder is renamed and deleted from its
 * heading: two buttons from `md` up, a ··· menu below it. Every change is a mutation on the device's rows, so one made on another device shows
 * here; the page that composes these (`SubscriptionsSection`) makes them.
 */
import { FOLDER_NAME_MAX, languageBadge } from '@tela/shared'
import type { SiteRow } from '@tela/sync'
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { checkFolderName } from '../lib/folders'
import { type cadenceKey, displayHost } from '../lib/format'
import { useDismiss } from '../lib/use-dismiss'
import { CHECK, CHEVRON_DOWN, Glyph } from './glyph'
import { Sheet } from './sheet'
import { SiteAvatar } from './site-avatar'

/** Three dots in a row: more for this, in a menu. */
const MORE = (
  <g fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </g>
)

/** A plus: make one. */
const PLUS = <path d="M8 4v8M4 8h8" />

/** One of the member's folders, as a choice. */
export type Folder = { id: string; name: string }

/** A blog the page lists: one followed, or one left from the page, dimmed, to take back. */
export type ManagedRow = {
  feedId: number
  subscribed: boolean
  title: string
  site: SiteRow | undefined
  cadence: ReturnType<typeof cadenceKey>
}

/** What the sections and their rows need from the page. */
export type Manage = {
  /** Below `md`: Move to is a sheet, and a folder's actions are behind ···. */
  phone: boolean
  /** The member's folders, by name. */
  folders: readonly Folder[]
  /** Put a blog in a folder, or in none (null). */
  move: (feedId: number, folderId: string | null) => void
  /** Below `md`: open Move to as a sheet for this row, from its folder button. */
  openSheet: (row: ManagedRow, from: HTMLButtonElement) => void
  rename: (folder: Folder, name: string) => void
  remove: (folder: Folder) => void
  toggle: (feedId: number, subscribed: boolean) => void
  /**
   * The blog whose folder button takes focus at the next render: the row Move to moved, which is
   * in another section by then and so another element.
   */
  focusMove: RefObject<number | null>
}

// ---------------------------------------------------------------------------------------------
// New folder

/** The quiet text button of a form here: Cancel, and a heading's Rename. */
const QUIET =
  'rounded-full px-3 py-[7px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-ink'

/** The filled one: Create, Save. */
const FILLED =
  'rounded-full bg-ink px-[15px] py-2 text-[13px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60'

const INPUT =
  'min-w-0 flex-1 rounded-lg border border-thumb bg-surface px-3 py-2 text-[14px] text-ink outline-none placeholder:text-muted focus:border-muted'

/**
 * A folder's name, to make one: Enter creates, Esc cancels. A name the member already has is
 * refused here, saying which (`checkFolderName`), and an empty one does nothing. `onCreate` is
 * given the name as it is kept, and makes the folder.
 */
export function NewFolderForm({
  folders,
  onCreate,
  onCancel,
  inSheet = false,
}: {
  folders: readonly Folder[]
  onCreate: (name: string) => void
  onCancel: () => void
  /** In Move to's sheet: on its surface, with a phone's targets. */
  inSheet?: boolean
}) {
  const t = useTranslations('settings.folders')
  const [value, setValue] = useState('')
  const [taken, setTaken] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const errorId = useId()
  useEffect(() => input.current?.focus(), [])
  const create = () => {
    const checked = checkFolderName(value, folders)
    if ('ok' in checked) onCreate(checked.ok)
    else if ('taken' in checked) setTaken(checked.taken)
    else input.current?.focus()
  }
  return (
    <div className={inSheet ? 'border-t border-line py-3' : 'mt-6 animate-fade'}>
      <div
        className={`flex items-center gap-2 ${inSheet ? '' : 'rounded-xl border border-line bg-surface p-3.5'}`}
      >
        <input
          ref={input}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setTaken(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              create()
            } else if (e.key === 'Escape') {
              // Only the form: in the sheet, Esc would close the sheet too.
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
          maxLength={FOLDER_NAME_MAX}
          placeholder={t('name')}
          aria-label={t('name')}
          aria-invalid={taken !== null}
          aria-describedby={taken !== null ? errorId : undefined}
          className={`${INPUT} ${inSheet ? 'min-h-11 text-[15px]' : ''}`}
          data-testid="new-folder-input"
        />
        <button type="button" onClick={onCancel} className={QUIET}>
          {t('cancel')}
        </button>
        <button type="button" onClick={create} className={FILLED} data-testid="new-folder-create">
          {t('create')}
        </button>
      </div>
      {taken !== null ? (
        <p
          id={errorId}
          role="alert"
          className="mt-2 text-[13px] text-danger"
          data-testid="new-folder-error"
        >
          {t('taken', { name: taken })}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A folder's section

/**
 * One section: a folder's (`folder`), or the blogs in none (null), whose heading shows only once
 * there are folders to be outside of. Its heading names it and counts the blogs followed in it; a
 * folder's renames in place and deletes.
 */
export function FolderSection({
  folder,
  rows,
  heading,
  manage,
  headingRef,
}: {
  folder: Folder | null
  rows: readonly ManagedRow[]
  /** Whether the section is named: the blogs in none are, once there are folders. */
  heading: boolean
  manage: Manage
  /** The heading of the blogs in none, which focus goes to once a folder is deleted. */
  headingRef?: RefObject<HTMLHeadingElement | null>
}) {
  const t = useTranslations('settings.folders')
  const headingId = useId()
  const count = rows.filter((r) => r.subscribed).length
  return (
    <section
      aria-labelledby={heading ? headingId : undefined}
      className="-mx-2.5 mt-[22px] rounded-[14px] px-2.5 pt-1.5 pb-1"
      data-testid="folder-group"
      data-folder-id={folder?.id ?? ''}
    >
      {heading ? (
        folder ? (
          <FolderHeading id={headingId} folder={folder} count={count} manage={manage} />
        ) : (
          <div className="flex min-h-12 items-center gap-3 pt-2 pb-3">
            <h3
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className="m-0 font-serif text-[20px] font-medium tracking-[-0.005em] outline-none md:text-[22px]"
            >
              {t('unfiled')}
            </h3>
            <span className="text-[12.5px] text-muted md:text-[13px]">
              {t('blogs', { n: count })}
            </span>
          </div>
        )
      ) : null}
      {rows.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <SubscriptionRow key={r.feedId} row={r} folder={folder} manage={manage} />
          ))}
        </ul>
      ) : heading ? (
        <p className="m-0 border-t border-line py-[18px] text-[13px] text-muted">
          {folder ? t('emptyPhone') : t('allFiled')}
        </p>
      ) : null}
    </section>
  )
}

/** A folder's name and count, and Rename and Delete folder: buttons, or behind ··· on a phone. */
function FolderHeading({
  id,
  folder,
  count,
  manage,
}: {
  /** The heading's id, which names the section. */
  id: string
  folder: Folder
  count: number
  manage: Manage
}) {
  const t = useTranslations('settings.folders')
  const [renaming, setRenaming] = useState(false)
  // What had focus before renaming gets it back after: Rename, or the ··· it was chosen from.
  const back = useRef<HTMLButtonElement>(null)
  const returning = useRef(false)
  useLayoutEffect(() => {
    if (renaming || !returning.current) return
    returning.current = false
    back.current?.focus()
  }, [renaming])
  const done = () => {
    returning.current = true
    setRenaming(false)
  }
  if (renaming) {
    return (
      <RenameForm
        folder={folder}
        folders={manage.folders}
        onSave={(name) => {
          if (name !== folder.name) manage.rename(folder, name)
          done()
        }}
        onCancel={done}
      />
    )
  }
  return (
    <div className="flex min-h-12 items-center gap-2.5 pt-2 pb-3 md:gap-3">
      <h3
        id={id}
        className="m-0 min-w-0 truncate font-serif text-[20px] font-medium tracking-[-0.005em] md:text-[22px]"
      >
        {folder.name}
      </h3>
      <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted md:text-[13px]">
        {t('blogs', { n: count })}
      </span>
      <span className="flex-1" />
      {manage.phone ? (
        <FolderOptions
          folder={folder}
          button={back}
          onRename={() => setRenaming(true)}
          onDelete={() => manage.remove(folder)}
        />
      ) : (
        <div className="flex shrink-0 items-center">
          <button
            ref={back}
            type="button"
            onClick={() => setRenaming(true)}
            className="rounded-md px-[9px] py-[5px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-ink"
            data-testid="folder-rename"
          >
            {t('rename')}
          </button>
          <button
            type="button"
            onClick={() => manage.remove(folder)}
            className="rounded-md px-[9px] py-[5px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-danger"
            data-testid="folder-delete"
          >
            {t('delete')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A folder's name, edited in place: Enter saves, Esc cancels, and an empty name changes nothing.
 * A name another of the member's folders has is refused, saying which; its own, in another case,
 * is not.
 */
function RenameForm({
  folder,
  folders,
  onSave,
  onCancel,
}: {
  folder: Folder
  folders: readonly Folder[]
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('settings.folders')
  const [value, setValue] = useState(folder.name)
  const [taken, setTaken] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const errorId = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const save = () => {
    const checked = checkFolderName(value, folders, folder.id)
    if ('ok' in checked) onSave(checked.ok)
    else if ('taken' in checked) setTaken(checked.taken)
    else onCancel()
  }
  return (
    <div className="pt-2 pb-3">
      <div className="flex min-h-12 items-center gap-2">
        <input
          ref={input}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setTaken(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          maxLength={FOLDER_NAME_MAX}
          aria-label={t('renameLabel', { name: folder.name })}
          aria-invalid={taken !== null}
          aria-describedby={taken !== null ? errorId : undefined}
          className="min-w-0 flex-1 rounded-lg border border-thumb bg-surface px-2.5 py-1 font-serif text-[20px] text-ink outline-none focus:border-muted"
          data-testid="folder-rename-input"
        />
        <button type="button" onClick={onCancel} className={QUIET}>
          {t('cancel')}
        </button>
        <button type="button" onClick={save} className={FILLED} data-testid="folder-rename-save">
          {t('save')}
        </button>
      </div>
      {taken !== null ? (
        <p
          id={errorId}
          role="alert"
          className="mt-2 mb-0 text-[13px] text-danger"
          data-testid="folder-rename-error"
        >
          {t('taken', { name: taken })}
        </p>
      ) : null}
    </div>
  )
}

/** A phone's ··· beside a folder's name: Rename and Delete folder (screen 27). */
function FolderOptions({
  folder,
  button,
  onRename,
  onDelete,
}: {
  folder: Folder
  /** The ··· itself, which focus goes back to. */
  button: RefObject<HTMLButtonElement | null>
  onRename: () => void
  onDelete: () => void
}) {
  const t = useTranslations('settings.folders')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const panel = useId()
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  const item =
    'flex min-h-11 items-center rounded-lg px-3.5 text-left text-[15px] text-ink hover:bg-paper'
  return (
    <div ref={box} className="relative -mr-2.5 shrink-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={t('options', { name: folder.name })}
        onClick={() => setOpen((o) => !o)}
        className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
        data-testid="folder-more"
      >
        <Glyph>{MORE}</Glyph>
      </button>
      {open ? (
        <div
          id={panel}
          className="absolute top-[calc(100%+4px)] right-0 z-[7] flex min-w-[180px] animate-fade flex-col rounded-xl border border-line bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,.10)]"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
            className={item}
            data-testid="folder-rename"
          >
            {t('rename')}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className={`${item} hover:text-danger`}
            data-testid="folder-delete"
          >
            {t('delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A row

/**
 * A blog: its picture, name, address, language and how often it posts, the folder button, and
 * Unsubscribe (or Subscribe, on a row left from here). From `md` up it is one line; on a phone
 * the folder button is under its name, since a 320px line has no room for it beside Unsubscribe.
 */
function SubscriptionRow({
  row,
  folder,
  manage,
}: {
  row: ManagedRow
  folder: Folder | null
  manage: Manage
}) {
  const t = useTranslations('settings')
  const td = useTranslations('discover')
  const { phone } = manage
  const listed = row.site?.listing === 'listed' || row.site?.listing === 'featured'
  const meta = [
    row.site ? displayHost(row.site.homeUrl) : null,
    row.site?.primaryLang ? languageBadge(row.site.primaryLang) : null,
    td(`cadence.${row.cadence}`),
  ]
    .filter(Boolean)
    .join(' · ')
  const dim = row.subscribed ? '' : 'opacity-55'
  const name = (
    <div className="min-w-0 flex-1">
      <div className="truncate">
        {row.site && listed ? (
          <Link to={`/s/${row.site.id}`} className="font-medium text-ink hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="font-medium">{row.title}</span>
        )}
      </div>
      <div className="truncate text-[12.5px] text-muted">{meta}</div>
    </div>
  )
  const toggle = (
    <button
      type="button"
      onClick={() => manage.toggle(row.feedId, row.subscribed)}
      data-testid="settings-subscription-toggle"
      className={`min-w-[104px] shrink-0 rounded-full border px-3 py-[5px] text-[12.5px] font-medium ${
        row.subscribed ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'
      }`}
    >
      {row.subscribed ? t('unsubscribe') : t('subscribe')}
    </button>
  )
  const avatar = (
    <SiteAvatar
      id={row.site?.id ?? row.feedId}
      title={row.title}
      faviconKey={row.site?.faviconKey ?? null}
      size={phone ? 30 : 32}
    />
  )
  const button = <FolderButton row={row} folder={folder} manage={manage} />
  if (phone) {
    return (
      <li
        className={`border-t border-line py-3 ${dim}`}
        data-testid="settings-subscription"
        data-feed-id={row.feedId}
      >
        <div className="flex items-center gap-3">
          {avatar}
          {name}
          {toggle}
        </div>
        <div className="mt-2 flex pl-[42px]">{button}</div>
      </li>
    )
  }
  return (
    <li
      className={`flex items-center gap-3 border-t border-line py-3 lg:gap-3.5 ${dim}`}
      data-testid="settings-subscription"
      data-feed-id={row.feedId}
    >
      {avatar}
      {name}
      {button}
      {toggle}
    </li>
  )
}

/**
 * The folder a row's blog is in, as a button: Move to opens from it, a menu from `md` up and a
 * sheet below it. It takes focus back when the row it is on was just moved (`focusMove`): the
 * row is in another section by then, and the button another element.
 */
function FolderButton({
  row,
  folder,
  manage,
}: {
  row: ManagedRow
  folder: Folder | null
  manage: Manage
}) {
  const t = useTranslations('settings.folders')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const panel = useId()
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  const current = folder?.name ?? t('none')
  const choose = (folderId: string | null) => {
    // Focus stays with this blog's button, wherever the move puts it.
    manage.focusMove.current = row.feedId
    setOpen(false)
    manage.move(row.feedId, folderId)
  }
  return (
    <div ref={box} className="relative min-w-0 shrink-0">
      <button
        ref={(el) => {
          button.current = el
          if (el && manage.focusMove.current === row.feedId) {
            manage.focusMove.current = null
            el.focus()
          }
        }}
        type="button"
        aria-haspopup={manage.phone ? 'dialog' : 'menu'}
        aria-expanded={manage.phone ? undefined : open}
        aria-controls={open ? panel : undefined}
        aria-label={t('folderOf', { blog: row.title, folder: current })}
        onClick={(e) =>
          manage.phone ? manage.openSheet(row, e.currentTarget) : setOpen((o) => !o)
        }
        className={`flex max-w-40 items-center gap-1.5 rounded-lg border border-line bg-surface pr-2.5 pl-3 text-ink-2 hover:border-thumb hover:text-ink ${manage.phone ? 'min-h-9 text-[13px]' : 'py-[5px] text-[12.5px]'}`}
        data-testid="move-to"
      >
        <span className="truncate">{current}</span>
        <Glyph size={12} className="shrink-0">
          {CHEVRON_DOWN}
        </Glyph>
      </button>
      {open ? (
        <div
          id={panel}
          className="absolute top-[calc(100%+6px)] right-0 z-[7] flex max-h-[min(360px,60vh)] min-w-[200px] animate-fade flex-col overflow-y-auto rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]"
        >
          <MoveOptions folders={manage.folders} current={folder?.id ?? null} onChoose={choose} />
        </div>
      ) : null}
    </div>
  )
}

/** The choice a Move to menu has checked: where focus goes as it opens. */
const checkedIn = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? null

/** Up, Down, Home and End between the choices of a menu, as an ARIA menu moves. */
function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  const active = document.activeElement
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1
  const to =
    e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : e.key === 'ArrowUp'
        ? (at - 1 + items.length) % items.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : null
  if (to === null) return
  e.preventDefault()
  items[to]?.focus()
}

/**
 * Move to: each folder, then No folder, the one the blog is in checked. Opened, it puts focus on
 * that one; Up and Down go between them, and Esc or Tab leaves.
 */
function MoveOptions({
  folders,
  current,
  onChoose,
  inSheet = false,
  labelledBy,
}: {
  folders: readonly Folder[]
  current: string | null
  onChoose: (folderId: string | null) => void
  inSheet?: boolean
  /** The sheet's title, which names its menu; the menu's own heading names it otherwise. */
  labelledBy?: string
}) {
  const t = useTranslations('settings.folders')
  const menu = useRef<HTMLDivElement>(null)
  const headingId = useId()
  // The sheet does this itself: opening a modal dialog moves focus to its first control, after
  // anything in it has had its effects run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the menu opens
  useEffect(() => {
    if (!inSheet) checkedIn(menu.current)?.focus()
  }, [])
  const options: { id: string | null; name: string }[] = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: null, name: t('none') },
  ]
  return (
    <>
      {inSheet ? null : (
        <div
          id={headingId}
          className="px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
        >
          {t('moveTo')}
        </div>
      )}
      <div
        ref={menu}
        role="menu"
        aria-labelledby={labelledBy ?? headingId}
        onKeyDown={menuKeys}
        className="flex flex-col"
        data-testid="move-to-menu"
      >
        {options.map((o) => {
          const on = o.id === current
          return (
            <button
              key={o.id ?? ''}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChoose(o.id)}
              className={
                inSheet
                  ? 'flex min-h-[50px] items-center gap-2.5 border-t border-line text-left text-[15px] text-ink'
                  : `flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-hover ${on ? 'bg-hover' : ''}`
              }
              data-testid="move-to-option"
            >
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {on ? (
                <Glyph size={inSheet ? 16 : 12} strokeWidth={1.8} className="shrink-0">
                  {CHECK}
                </Glyph>
              ) : null}
            </button>
          )
        })}
      </div>
    </>
  )
}

/**
 * Move to on a phone (screen 27): a sheet titled with the blog, its folders and No folder, the one
 * it is in checked, and New folder, which makes a folder and puts the blog in it. Choosing closes
 * it, and focus goes back to the blog's folder button.
 */
export function MoveSheet({
  row,
  current,
  folders,
  opener,
  canCreate,
  limitHint,
  onChoose,
  onCreate,
  onClose,
}: {
  row: ManagedRow
  current: string | null
  folders: readonly Folder[]
  opener: RefObject<HTMLElement | null>
  /** False once the member has as many folders as there can be. */
  canCreate: boolean
  limitHint: string
  onChoose: (folderId: string | null) => void
  /** Make a folder of this name with the blog in it. */
  onCreate: (name: string) => void
  onClose: () => void
}) {
  const t = useTranslations('settings.folders')
  const titleId = useId()
  const hintId = useId()
  const [naming, setNaming] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const plus = useRef<HTMLButtonElement>(null)
  // After the sheet's own effect has opened it (a child's effects run first), which put focus on
  // its first choice: the one the blog is in is where a choice starts.
  useEffect(() => checkedIn(body.current)?.focus(), [])
  // New folder cancelled: focus goes back to its row, which is back by then.
  const returning = useRef(false)
  useLayoutEffect(() => {
    if (naming || !returning.current) return
    returning.current = false
    plus.current?.focus()
  }, [naming])
  return (
    <Sheet labelledBy={titleId} opener={opener} onClose={onClose} testId="move-sheet" className="">
      <h2
        id={titleId}
        className="mt-4 mb-2.5 font-serif text-[24px] leading-tight font-medium break-words"
      >
        {t('moveBlogTo', { blog: row.title })}
      </h2>
      <div ref={body} className="contents">
        <MoveOptions
          folders={folders}
          current={current}
          onChoose={onChoose}
          inSheet
          labelledBy={titleId}
        />
      </div>
      {naming ? (
        <NewFolderForm
          folders={folders}
          onCreate={onCreate}
          onCancel={() => {
            returning.current = true
            setNaming(false)
          }}
          inSheet
        />
      ) : (
        <>
          <button
            ref={plus}
            type="button"
            disabled={!canCreate}
            aria-describedby={canCreate ? undefined : hintId}
            onClick={() => setNaming(true)}
            className="flex min-h-[50px] items-center gap-2.5 border-t border-line text-left text-[15px] text-muted hover:text-ink disabled:opacity-60"
            data-testid="move-sheet-new-folder"
          >
            <Glyph size={18} strokeWidth={1.4}>
              {PLUS}
            </Glyph>
            {t('new')}
          </button>
          {canCreate ? null : (
            <p id={hintId} className="m-0 text-[12.5px] text-muted">
              {limitHint}
            </p>
          )}
        </>
      )}
    </Sheet>
  )
}
