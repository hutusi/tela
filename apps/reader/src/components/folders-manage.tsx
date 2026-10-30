/**
 * Settings › Subscriptions below `lg` (ADR 0049, Tela Lists screen 27): a section per folder, by
 * name, each with its blogs by title, then the blogs in none. Each row's folder button opens Move
 * to as a sheet, and a ··· beside a folder's name holds Rename and Delete folder. The forms and the
 * Move to menu are the manager's too (`subscriptions-manager.tsx`, from `lg` up). Every change is a
 * mutation on the device's rows, so one made on another device shows here; the page that composes
 * these (`SubscriptionsSection`) makes them.
 */
import { FOLDER_NAME_MAX, languageBadge } from '@tela/shared'
import type { SiteRow } from '@tela/sync'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import { useLocale, useTranslations } from 'use-intl'
import { checkFolderName } from '../lib/folders'
import { blogAddress } from '../lib/format'
import { postedAgo } from '../lib/subscriptions'
import { useDismiss } from '../lib/use-dismiss'
import { CHECK, CHEVRON_DOWN, Glyph } from './glyph'
import { MENU_ITEM, menuPanel } from './header-control'
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
export const PLUS = <path d="M8 4v8M4 8h8" />

/** One of the member's folders, as a choice. */
export type Folder = { id: string; name: string }

/** A blog the member follows, as Subscriptions lists it. */
export type ManagedRow = {
  feedId: number
  title: string
  site: SiteRow | undefined
  feedUrl: string | undefined
  /** The live folder it is in, or null for none. */
  folderId: string | null
  /** When it last posted (`latestPosts`), or null if nothing says. */
  latest: number | null
  /** Its feed no longer updates: it reads "Not updating", whatever its last date. */
  dead: boolean
}

/** What a row says of how its blog posts: when it last did, or that it has stopped. */
export function useActivity(now: number): (row: ManagedRow) => string {
  const t = useTranslations('settings.folders')
  const locale = useLocale()
  return (row) =>
    row.dead
      ? t('notUpdating')
      : row.latest === null
        ? t('noPosts')
        : postedAgo(row.latest, locale, now)
}

/** What the sections and their rows need from the page. */
export type Manage = {
  /** The member's folders, by name. */
  folders: readonly Folder[]
  /** Every name a folder may not take: these, and a folder whose deletion is held (`knownFolders`). */
  known: readonly Folder[]
  /** Open Move to as a sheet for this row, from its folder button. */
  openSheet: (row: ManagedRow, from: HTMLButtonElement) => void
  rename: (folder: Folder, name: string) => void
  remove: (folder: Folder) => void
  /**
   * Open New blogroll with this folder's name and blogs in it (ADR 0050), focus going back to
   * `from` (its ···) when it closes.
   */
  makeBlogroll: (folder: Folder, from: HTMLElement | null) => void
  unsubscribe: (row: ManagedRow) => void
  /** Each row's second line: its address, language and latest post (`useActivity`). */
  activity: (row: ManagedRow) => string
  /**
   * The blog whose folder button takes focus at the next render: the row Move to moved, which is
   * in another section by then and so another element.
   */
  focusMove: RefObject<number | null>
  /** The blog whose Unsubscribe takes focus at the next render: the next row, once one has gone. */
  focusLeave: RefObject<number | null>
}

// ---------------------------------------------------------------------------------------------
// New folder

/** The quiet text button of a form here: Cancel, and a heading's Rename. */
export const QUIET =
  'rounded-full px-3 py-[7px] text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-ink'

/** The filled one: Create, Save. */
export const FILLED =
  'rounded-full bg-ink px-[15px] py-2 text-[13px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60'

const INPUT =
  'min-w-0 flex-1 rounded-lg border border-thumb bg-surface px-3 py-2 text-[14px] text-ink outline-none placeholder:text-muted focus:border-muted'

/**
 * A folder's name, to make one: Enter creates, Esc cancels. A name the member already has is
 * refused here, saying which (`checkFolderName`), and an empty one does nothing. `onCreate` is
 * given the name as it is kept, and makes the folder. On the page it is a card; in Move to's sheet
 * a row with a phone's targets; in the manager's folder pane (`pane`) a column, under a line that
 * says which blogs go in it, if any (`label`).
 */
export function NewFolderForm({
  folders,
  onCreate,
  onCancel,
  variant = 'page',
  label,
}: {
  folders: readonly Folder[]
  onCreate: (name: string) => void
  onCancel: () => void
  variant?: 'page' | 'sheet' | 'pane'
  label?: string | undefined
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
  const pane = variant === 'pane'
  const field = (
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
          // Only the form: in the sheet, Esc would close the sheet too, and in the manager leave
          // Select mode.
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
      maxLength={FOLDER_NAME_MAX}
      placeholder={t('name')}
      aria-label={label ?? t('name')}
      aria-invalid={taken !== null}
      aria-describedby={taken !== null ? errorId : undefined}
      className={`${INPUT} ${variant === 'sheet' ? 'min-h-11 text-[15px]' : ''} ${pane ? 'w-full flex-none border-muted px-2.5 py-[7px] text-[13.5px]' : ''}`}
      data-testid="new-folder-input"
    />
  )
  const error =
    taken !== null ? (
      <p
        id={errorId}
        role="alert"
        className={`text-danger ${pane ? 'm-0 px-1 text-[12px]' : 'mt-2 text-[13px]'}`}
        data-testid="new-folder-error"
      >
        {t('taken', { name: taken })}
      </p>
    ) : null
  if (pane) {
    return (
      <div className="flex animate-fade flex-col gap-1.5 px-0.5 pt-0.5 pb-2.5">
        {label ? <span className="px-1 text-[12px] text-muted">{label}</span> : null}
        {field}
        {error}
        <div className="flex justify-end gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-2.5 py-[5px] text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={create}
            className="rounded-full bg-ink px-3 py-[5px] text-[12.5px] font-medium text-paper hover:brightness-125"
            data-testid="new-folder-create"
          >
            {t('create')}
          </button>
        </div>
      </div>
    )
  }
  const inSheet = variant === 'sheet'
  return (
    <div className={inSheet ? 'border-t border-line py-3' : 'mt-6 animate-fade'}>
      <div
        className={`flex items-center gap-2 ${inSheet ? '' : 'rounded-xl border border-line bg-surface p-3.5'}`}
      >
        {field}
        <button type="button" onClick={onCancel} className={QUIET}>
          {t('cancel')}
        </button>
        <button type="button" onClick={create} className={FILLED} data-testid="new-folder-create">
          {t('create')}
        </button>
      </div>
      {error}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A folder's section

/**
 * One section: a folder's (`folder`), or the blogs in none (null), whose heading shows only once
 * there are folders to be outside of. Its heading names it and counts its blogs (those the filter
 * shows, while there is one); a folder's renames in place and deletes, from its ···.
 */
export function FolderSection({
  folder,
  rows,
  heading,
  filtering,
  manage,
  headingRef,
}: {
  folder: Folder | null
  rows: readonly ManagedRow[]
  /** Whether the section is named: the blogs in none are, once there are folders. */
  heading: boolean
  /** A filter is on: an empty section is one it emptied, and is not shown at all. */
  filtering: boolean
  manage: Manage
  /** The heading of the blogs in none, which focus goes to once a folder is deleted. */
  headingRef?: RefObject<HTMLHeadingElement | null>
}) {
  const t = useTranslations('settings.folders')
  const headingId = useId()
  if (filtering && rows.length === 0) return null
  return (
    <section
      aria-labelledby={heading ? headingId : undefined}
      className="mt-[22px]"
      data-testid="folder-group"
      data-folder-id={folder?.id ?? ''}
    >
      {heading ? (
        folder ? (
          <FolderHeading id={headingId} folder={folder} count={rows.length} manage={manage} />
        ) : (
          <div className="flex min-h-12 items-center gap-3 pt-2 pb-3">
            <h3
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className="m-0 font-serif text-[20px] font-medium tracking-[-0.005em] outline-none"
            >
              {t('unfiled')}
            </h3>
            <span className="text-[12.5px] text-muted">{t('blogs', { n: rows.length })}</span>
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

/** A folder's name and count, and its ···: Rename and Delete folder. */
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
  // The ··· that Rename was chosen from has focus back after it.
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
        folders={manage.known}
        onSave={(name) => {
          if (name !== folder.name) manage.rename(folder, name)
          done()
        }}
        onCancel={done}
      />
    )
  }
  return (
    <div className="flex min-h-12 items-center gap-2.5 pt-2 pb-3">
      <h3
        id={id}
        className="m-0 min-w-0 truncate font-serif text-[20px] font-medium tracking-[-0.005em]"
      >
        {folder.name}
      </h3>
      <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted">
        {t('blogs', { n: count })}
      </span>
      <span className="flex-1" />
      <FolderOptions
        folder={folder}
        button={back}
        onRename={() => setRenaming(true)}
        onDelete={() => manage.remove(folder)}
        onMakeBlogroll={() => manage.makeBlogroll(folder, back.current)}
      />
    </div>
  )
}

/**
 * A folder's name, edited in place: Enter saves, Esc cancels, and an empty name changes nothing.
 * A name another of the member's folders has is refused, saying which; its own, in another case,
 * is not. In a section's heading it takes the line; in the manager's toolbar (`inToolbar`) it
 * takes up to 380px of it.
 */
export function RenameForm({
  folder,
  folders,
  onSave,
  onCancel,
  inToolbar = false,
}: {
  folder: Folder
  folders: readonly Folder[]
  onSave: (name: string) => void
  onCancel: () => void
  inToolbar?: boolean
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
    <div className={inToolbar ? 'min-w-0 flex-[0_1_380px]' : 'pt-2 pb-3'}>
      <div className={`flex items-center ${inToolbar ? 'gap-1.5' : 'min-h-12 gap-2'}`}>
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
              // Only the form, as New folder's does.
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
          maxLength={FOLDER_NAME_MAX}
          aria-label={t('renameLabel', { name: folder.name })}
          aria-invalid={taken !== null}
          aria-describedby={taken !== null ? errorId : undefined}
          className={`min-w-0 flex-1 rounded-lg border bg-surface px-2.5 font-serif text-ink outline-none focus:border-muted ${inToolbar ? 'border-muted py-[3px] text-[19px]' : 'border-thumb py-1 text-[20px]'}`}
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

/**
 * The ··· beside a folder's name: Rename and Delete folder (screen 27), and Make a blogroll from
 * it (ADR 0050).
 */
function FolderOptions({
  folder,
  button,
  onRename,
  onDelete,
  onMakeBlogroll,
}: {
  folder: Folder
  /** The ··· itself, which focus goes back to. */
  button: RefObject<HTMLButtonElement | null>
  onRename: () => void
  onDelete: () => void
  onMakeBlogroll: () => void
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
        <div id={panel} className={menuPanel({ minWidth: 'min-w-[180px]' })}>
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
              onMakeBlogroll()
            }}
            className={item}
            data-testid="folder-make-blogroll"
          >
            {t('makeBlogroll')}
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
 * A blog: its picture and name, then its address, language and latest post, and Unsubscribe; its
 * folder button on a line of its own under its name, since a 320px line has no room for it
 * beside Unsubscribe.
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
  return (
    <li
      className="border-t border-line py-3"
      data-testid="settings-subscription"
      data-feed-id={row.feedId}
    >
      <div className="flex items-center gap-3">
        <SiteAvatar
          id={row.site?.id ?? row.feedId}
          title={row.title}
          faviconKey={row.site?.faviconKey ?? null}
          size={30}
        />
        <BlogName row={row} meta={rowMeta(row, manage.activity(row))} />
        <button
          ref={(el) => {
            if (el && manage.focusLeave.current === row.feedId) {
              manage.focusLeave.current = null
              el.focus()
            }
          }}
          type="button"
          onClick={() => manage.unsubscribe(row)}
          data-testid="settings-unsubscribe"
          className="shrink-0 rounded-full border border-thumb px-3 py-[5px] text-[12.5px] font-medium text-ink-2 hover:border-ink hover:text-ink"
        >
          {t('unsubscribe')}
        </button>
      </div>
      <div className="mt-2 flex pl-[42px]">
        <FolderButton row={row} folder={folder} manage={manage} />
      </div>
    </li>
  )
}

/** A row's second line: its address, its language, and how it posts. */
export function rowMeta(row: ManagedRow, activity: string): string {
  return [
    row.site ? blogAddress(row.site.homeUrl) : null,
    row.site?.primaryLang ? languageBadge(row.site.primaryLang) : null,
    activity,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A blog's name, a link to its page where it has one, over its second line. */
export function BlogName({
  row,
  meta,
  link = true,
}: {
  row: ManagedRow
  meta: string
  /** False where a click on the row is the row's own (the manager in Select mode). */
  link?: boolean
}) {
  const listed = row.site?.listing === 'listed' || row.site?.listing === 'featured'
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate">
        {link && row.site && listed ? (
          <Link
            to={`/s/${row.site.id}`}
            draggable={false}
            className="font-medium text-ink hover:underline"
          >
            {row.title}
          </Link>
        ) : (
          <span className="font-medium">{row.title}</span>
        )}
      </div>
      <div className="truncate text-[12.5px] text-muted lg:text-[12px]">{meta}</div>
    </div>
  )
}

/**
 * The folder a row's blog is in, as a button that opens Move to as a sheet. It takes focus back
 * when the row it is on was just moved (`focusMove`): the row is in another section by then, and
 * the button another element.
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
  const current = folder?.name ?? t('none')
  return (
    <button
      ref={(el) => {
        if (el && manage.focusMove.current === row.feedId) {
          manage.focusMove.current = null
          el.focus()
        }
      }}
      type="button"
      aria-haspopup="dialog"
      aria-label={t('folderOf', { blog: row.title, folder: current })}
      onClick={(e) => manage.openSheet(row, e.currentTarget)}
      className="flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface pr-2.5 pl-3 text-[13px] text-ink-2 hover:border-thumb hover:text-ink"
      data-testid="move-to"
    >
      <span className="truncate">{current}</span>
      <Glyph size={12} className="shrink-0">
        {CHEVRON_DOWN}
      </Glyph>
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Move to

/** The choice a Move to menu has checked, or its first: where focus goes as it opens. */
const startIn = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
  el?.querySelector<HTMLElement>('[role^="menuitem"]') ??
  null

/** Up, Down, Home and End between the items of a menu, as an ARIA menu moves. */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
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

/** An item of a menu beside its choices, after a rule: Unsubscribe, New folder with these. */
export function MenuItem({
  onClick,
  testId,
  muted = false,
  children,
}: {
  onClick: () => void
  testId: string
  muted?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onClick}
      className={`${MENU_ITEM} hover:text-ink ${muted ? 'text-muted' : 'text-ink'}`}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/**
 * Move to: each folder, then No folder, the one the blog is in checked (none, for several blogs in
 * different folders: `current` undefined). Opened, it puts focus on that one, or the first; Up and
 * Down go between them and any `extra` items under a rule, and Esc or Tab leaves.
 */
export function MoveOptions({
  folders,
  current,
  onChoose,
  inSheet = false,
  labelledBy,
  heading = true,
  extra,
}: {
  folders: readonly Folder[]
  current: string | null | undefined
  onChoose: (folderId: string | null) => void
  inSheet?: boolean
  /** The sheet's title, or the button, that names its menu; its own heading names it otherwise. */
  labelledBy?: string
  heading?: boolean
  extra?: ReactNode
}) {
  const t = useTranslations('settings.folders')
  const menu = useRef<HTMLDivElement>(null)
  const headingId = useId()
  // The sheet does this itself: opening a modal dialog moves focus to its first control, after
  // anything in it has had its effects run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the menu opens
  useEffect(() => {
    if (!inSheet) startIn(menu.current)?.focus()
  }, [])
  const options: { id: string | null; name: string }[] = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: null, name: t('none') },
  ]
  const named = !inSheet && heading
  return (
    <>
      {named ? (
        <div
          id={headingId}
          className="px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
        >
          {t('moveTo')}
        </div>
      ) : null}
      <div
        ref={menu}
        role="menu"
        aria-labelledby={labelledBy ?? (named ? headingId : undefined)}
        onKeyDown={menuKeys}
        className="flex flex-col"
        data-testid="move-to-menu"
      >
        {options.map((o, i) => {
          const on = o.id === current
          return (
            <button
              key={o.id ?? ''}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              tabIndex={on || (current === undefined && i === 0) ? 0 : -1}
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
        {extra ? (
          <>
            <hr className="my-1 h-px border-0 bg-line" />
            {extra}
          </>
        ) : null}
      </div>
    </>
  )
}

/**
 * Move to below `lg` (screen 27): a sheet titled with the blog, its folders and No folder, the one
 * it is in checked, and New folder, which makes a folder and puts the blog in it. Choosing closes
 * it, and focus goes back to the blog's folder button.
 */
export function MoveSheet({
  row,
  current,
  folders,
  known,
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
  /** The names a new folder may not take (`knownFolders`). */
  known: readonly Folder[]
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
  useEffect(() => startIn(body.current)?.focus(), [])
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
          folders={known}
          onCreate={onCreate}
          onCancel={() => {
            returning.current = true
            setNaming(false)
          }}
          variant="sheet"
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
