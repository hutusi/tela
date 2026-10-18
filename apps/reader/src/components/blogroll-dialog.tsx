/**
 * New blogroll and Edit blogroll (ADR 0050): a centred dialog from `md`, a bottom sheet below.
 * It makes its own changes: Create makes the blogroll (with `initial.feedIds` in it, from a
 * folder) and opens its page; Save changes the name and description; Delete blogroll deletes it,
 * held while its Undo shows.
 *
 * From the design (Tela Lists, the New and Edit modal): the serif title, Name, an optional
 * Description, "Who can see it" as two choices with what each means, then Cancel and Create or
 * Save, and on Edit, Delete on the left. Making it public on Edit is the blogroll's own switch
 * (`setBlogrollPublic`), which waits while this device's last change to it is on its way.
 */
import {
  BLOGROLL_DESCRIPTION_MAX,
  BLOGROLL_NAME_MAX,
  blogrollName,
  blogrollText,
  MAX_BLOGROLL_BLOGS,
  MAX_BLOGROLLS,
  textLength,
} from '@tela/shared'
import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useNavigate } from 'react-router'
import { useTranslations } from 'use-intl'
import { blogrollHref } from '../lib/blogroll-href'
import {
  blogrollAgain,
  blogrollWith,
  canMakeBlogroll,
  knownBlogrolls,
  newBlogrollId,
} from '../lib/blogrolls'
import { UNDO_HOLD_MS } from '../lib/toasts'
import { offerUndo } from '../lib/undo'
import { liveBlogs } from '../store/blogrolls'
import { useStore, useTables } from '../store/hooks'
import { ResponsiveDialog } from './modal'

export type BlogrollDialogProps = {
  /** Editing this blogroll of the member's; absent, the dialog makes a new one. */
  editing?: string
  /** A new blogroll's starting name and blogs: Make a blogroll from a folder. */
  initial?: { name: string; feedIds: number[] }
  /** The control that opened it, to return focus to. */
  opener?: HTMLElement | null
  onClose: () => void
}

/** What a newly made blogroll's page is told: open Add blogs, since it has none yet. */
export type BlogrollPageState = { addBlogs?: boolean }

/**
 * Whether a blogroll has to wait before it can be made public: a change this device made to its
 * switch is still on its way, or the blogroll was made here and has not come back in a pull
 * (`LocalStore.blogrollPublicUnsettled`, issue #16).
 */
export function useBlogrollPublicUnsettled(id: string | undefined): boolean {
  const { store } = useStore()
  const unsettled = () => (id === undefined ? false : store.blogrollPublicUnsettled(id))
  return useSyncExternalStore(store.subscribe, unsettled, unsettled)
}

const INPUT =
  'w-full rounded-lg border border-thumb bg-surface px-3 py-2.5 text-ink outline-none placeholder:text-muted focus:border-muted max-md:text-[16px]'

/** A count beside a field's label: how much of its limit it uses, in `danger` once past it. */
function Counter({ n, max }: { n: number; max: number }) {
  const t = useTranslations('blogroll')
  return (
    <span
      className={`text-[12px] font-normal tabular-nums ${n > max ? 'text-danger' : 'text-muted'}`}
    >
      {t('count', { n, max })}
    </span>
  )
}

export function BlogrollDialog({ editing, initial, opener, onClose }: BlogrollDialogProps) {
  const t = useTranslations('blogroll.dialog')
  const tt = useTranslations('toast')
  const { store } = useStore()
  const tables = useTables()
  const navigate = useNavigate()
  const row = editing === undefined ? undefined : tables.blogrolls.get(editing)
  const back = useRef<HTMLElement | null>(opener ?? null)
  const titleId = useId()
  const nameId = useId()
  const descriptionId = useId()
  const waitId = useId()
  const [name, setName] = useState(() => row?.name ?? initial?.name ?? '')
  const [description, setDescription] = useState(() => row?.description ?? '')
  const [isPublic, setPublic] = useState(() => row?.isPublic ?? false)
  // What the dialog opened on: Save sends only what the member changed here, so a rename, or a
  // switch to private, made on another device while it was open is not undone by its stale copy
  // (a show would even pass, against the version the pull brought).
  const [openedWith] = useState(() => ({
    name: row?.name ?? '',
    description: row?.description ?? '',
    isPublic: row?.isPublic ?? false,
  }))
  const unsettled = useBlogrollPublicUnsettled(editing)

  // Deleted elsewhere while open: there is nothing left to edit.
  const gone = editing !== undefined && row === undefined
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  // The limit reckons with a blogroll whose deletion is still held (ADR 0048's lesson).
  const canMake = useMemo(
    () => canMakeBlogroll(knownBlogrolls(tables, store.tablesBeforeHolds())),
    [tables, store],
  )
  if (gone) return null

  const feedIds = initial?.feedIds ?? []
  const kept = feedIds.slice(0, MAX_BLOGROLL_BLOGS)
  const nameLength = textLength(name.trim())
  const descriptionLength = textLength(description.trim())
  const clean = blogrollName(name)
  const valid =
    clean !== '' && nameLength <= BLOGROLL_NAME_MAX && descriptionLength <= BLOGROLL_DESCRIPTION_MAX
  // A show waits while the switch is unsettled; a hide never does.
  const publicLocked = row !== undefined && !row.isPublic && unsettled

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    const desc = blogrollText(description, BLOGROLL_DESCRIPTION_MAX)
    if (row) {
      const renamed = clean !== openedWith.name
      const described = desc !== openedWith.description
      if (renamed || described) {
        store.mutate({
          type: 'putBlogroll',
          id: row.id,
          // A field the member left alone keeps what the row holds now.
          name: renamed ? clean : row.name,
          description: described ? desc : row.description,
          isPublic: row.isPublic,
        })
      }
      if (isPublic !== openedWith.isPublic && isPublic !== row.isPublic) {
        store.setBlogrollPublic(row.id, isPublic)
      }
      onClose()
      return
    }
    // Asked again of the rows as they are now, not as this render saw them.
    const known = knownBlogrolls(store.getSnapshot().tables, store.tablesBeforeHolds())
    if (!canMakeBlogroll(known)) return
    const id = newBlogrollId()
    const made = store.mutateMany(
      blogrollWith({ id, name: clean, description: desc, isPublic, feedIds: kept }),
    )
    if (made.length === 0) return
    onClose()
    const state: BlogrollPageState = { addBlogs: kept.length === 0 }
    navigate(blogrollHref(id), { state })
  }

  const remove = () => {
    if (!row) return
    // What it held, before the deletion takes it from the view: an Undo after the deletion went
    // out makes it again from these.
    const blogs = liveBlogs(store.getSnapshot().tables, row.id)
    const was = { name: row.name, description: row.description, isPublic: row.isPublic }
    const held = store.mutate({ type: 'deleteBlogroll', id: row.id }, { holdMs: UNDO_HOLD_MS })
    if (!held) return
    offerUndo(store, t('deleted', { name: row.name }), tt('undo'), [held.mid], () =>
      store.mutateMany(blogrollAgain(was, blogs), { after: held.at }),
    )
    onClose()
    const handle = store.getSnapshot().tables.profile?.handle
    // The page it was on has gone with it.
    navigate(handle ? `/@${handle}?tab=blogrolls` : '/reading', { replace: true })
  }

  const choice = (on: boolean, label: string, hint: string, testId: string, disabled = false) => (
    <label
      className={`flex items-start gap-3 rounded-[10px] border px-3.5 py-3 ${isPublic === on ? 'border-ink' : 'border-line'} ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
      data-testid={testId}
    >
      <input
        type="radio"
        name={`${titleId}-who`}
        checked={isPublic === on}
        disabled={disabled}
        onChange={() => setPublic(on)}
        aria-describedby={disabled ? waitId : undefined}
        className="mt-[3px] size-4 shrink-0 accent-ink"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-[12.5px] leading-[1.45] text-muted">{hint}</span>
      </span>
    </label>
  )

  return (
    <ResponsiveDialog labelledBy={titleId} opener={back} onClose={onClose} testId="blogroll-dialog">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <h2
          id={titleId}
          className="m-0 font-serif text-[24px] leading-tight font-medium tracking-[-0.01em] md:text-[30px]"
        >
          {row ? t('edit') : t('new')}
        </h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={nameId} className="text-[13px] font-medium">
              {t('name')}
            </label>
            <Counter n={nameLength} max={BLOGROLL_NAME_MAX} />
          </div>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to be typed in.
            autoFocus
            autoComplete="off"
            aria-invalid={nameLength > BLOGROLL_NAME_MAX}
            className={`${INPUT} text-[15px]`}
            data-testid="blogroll-dialog-name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={descriptionId} className="text-[13px] font-medium">
              {t('description')} <span className="font-normal text-muted">{t('optional')}</span>
            </label>
            <Counter n={descriptionLength} max={BLOGROLL_DESCRIPTION_MAX} />
          </div>
          <textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={t('descriptionPlaceholder')}
            aria-invalid={descriptionLength > BLOGROLL_DESCRIPTION_MAX}
            className={`${INPUT} resize-y font-serif text-[17px] leading-[1.4] max-md:text-[17px]`}
            data-testid="blogroll-dialog-description"
          />
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] font-medium">{t('who')}</legend>
          {choice(false, t('private'), t('privateHint'), 'blogroll-dialog-private')}
          {choice(true, t('public'), t('publicHint'), 'blogroll-dialog-public', publicLocked)}
          {publicLocked ? (
            <p id={waitId} className="m-0 text-[12.5px] text-muted">
              {t('publicWait')}
            </p>
          ) : null}
        </fieldset>
        {initial && !row ? (
          <p
            className="m-0 text-[13px] leading-normal text-ink-2"
            data-testid="blogroll-dialog-from"
          >
            {feedIds.length > MAX_BLOGROLL_BLOGS
              ? t('capped', { n: feedIds.length, max: MAX_BLOGROLL_BLOGS })
              : t('fromFolder', { n: feedIds.length })}
          </p>
        ) : null}
        {!row && !canMake ? (
          <p
            className="m-0 text-[13px] text-danger"
            role="alert"
            data-testid="blogroll-dialog-limit"
          >
            {t('limit', { max: MAX_BLOGROLLS })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {row ? (
            <button
              type="button"
              onClick={remove}
              className="-ml-2.5 rounded-full px-2.5 py-[7px] text-[13px] text-muted hover:bg-hover hover:text-danger max-md:order-last max-md:mt-2 max-md:ml-0 max-md:min-h-11 max-md:w-full"
              data-testid="blogroll-delete"
            >
              {t('delete')}
            </button>
          ) : null}
          <span className="flex-1 max-md:hidden" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3.5 py-2 text-[13.5px] text-muted hover:bg-hover hover:text-ink max-md:min-h-[46px] max-md:flex-1 max-md:border max-md:border-thumb max-md:font-medium max-md:text-ink"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={!valid || (!row && !canMake)}
            className="rounded-full bg-ink px-5 py-[9px] text-[13.5px] font-medium text-paper hover:brightness-125 disabled:opacity-40 max-md:min-h-[46px] max-md:flex-[2]"
            data-testid="blogroll-dialog-submit"
          >
            {row ? t('save') : t('create')}
          </button>
        </div>
      </form>
    </ResponsiveDialog>
  )
}
