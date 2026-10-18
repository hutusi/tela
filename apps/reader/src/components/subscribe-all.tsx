/**
 * Subscribe to all, on someone else's blogroll (ADR 0050, Tela Lists and screen 24): a button that
 * counts what it adds ("Subscribe to all 6", "Subscribe to 4" when some are followed already,
 * "Subscribed to all"), and the panel it opens, a card under the header from `md` and a bottom
 * sheet below. The panel names the blogs already followed, which stay where they are, and asks
 * where the others go: a new folder (named after the blogroll until the member says otherwise),
 * one of theirs, or none. Pressed, it is one change, held while its toast offers Undo (ADR 0046);
 * an Undo after it went out unsubscribes each blog again and puts their filings back.
 *
 * It waits for the device's first pull: until then the device cannot tell a blog followed from
 * one not, and would subscribe to, and move, blogs the member already reads.
 */
import { folderName, MAX_FOLDERS } from '@tela/shared'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { blogLabel, type Destination, subscribeAllPlan, undoSubscribeAll } from '../lib/blogrolls'
import { canMakeFolder, checkFolderName, knownFolders } from '../lib/folders'
import { newId } from '../lib/id'
import { UNDO_HOLD_MS } from '../lib/toasts'
import { offerUndo } from '../lib/undo'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { useStore, useTables } from '../store/hooks'
import { PRIMARY_PILL, QUIET_PILL } from '../views/blogroll'
import type { BlogrollBlog, BlogrollData } from '../views/types'
import { CHECK, Glyph } from './glyph'
import { Sheet } from './sheet'

const follows = (t: ReturnType<typeof useTables>, feedId: number) =>
  t.subscriptions.get(feedId)?.deletedAt === null

export function SubscribeAll({ data }: { data: BlogrollData }) {
  const t = useTranslations('blogroll.subscribe')
  const tb = useTranslations('blogroll')
  const { store } = useStore()
  const tables = useTables()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const fresh = data.blogs.filter((b) => !follows(tables, b.feedId))
  const have = data.blogs.filter((b) => follows(tables, b.feedId))
  const ready = store.hasData
  // Subscribed to every one meanwhile, here or on another device: nothing is left to ask about.
  const showing = open && fresh.length > 0 && ready
  useEffect(() => {
    if (open && !showing) setOpen(false)
  }, [open, showing])

  const label =
    fresh.length === 0
      ? t('all')
      : have.length > 0
        ? t('some', { n: fresh.length })
        : tb('subscribeAll', { n: fresh.length })
  const close = () => setOpen(false)
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={fresh.length > 0 ? showing : undefined}
        disabled={!ready || fresh.length === 0}
        title={ready ? undefined : t('waiting')}
        onClick={() => setOpen((o) => !o)}
        className={fresh.length === 0 ? QUIET_PILL : PRIMARY_PILL}
        data-testid="blogroll-subscribe-all"
      >
        {fresh.length === 0 ? (
          <Glyph size={12} strokeWidth={1.8} className="block shrink-0">
            {CHECK}
          </Glyph>
        ) : null}
        {label}
      </button>
      {showing ? (
        <SubscribePanel data={data} fresh={fresh} have={have} opener={button} onClose={close} />
      ) : null}
    </>
  )
}

/** "You already subscribe to X", "… to X and Y", "… to X, Y and 3 others". */
function Already({ have }: { have: readonly BlogrollBlog[] }) {
  const t = useTranslations('blogroll.subscribe.already')
  const [a, b] = have.map(blogLabel)
  if (have.length === 1) return <>{t('one', { a: a ?? '' })}</>
  if (have.length === 2) return <>{t('two', { a: a ?? '', b: b ?? '' })}</>
  return <>{t('more', { a: a ?? '', b: b ?? '', n: have.length - 2 })}</>
}

function SubscribePanel({
  data,
  fresh,
  have,
  opener,
  onClose,
}: {
  data: BlogrollData
  fresh: readonly BlogrollBlog[]
  have: readonly BlogrollBlog[]
  opener: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const t = useTranslations('blogroll.subscribe')
  const tf = useTranslations('settings.folders')
  const tt = useTranslations('toast')
  const { store } = useStore()
  const tables = useTables()
  const phone = useMediaQuery(BELOW_MD)
  const titleId = useId()
  const nameId = useId()
  const errorId = useId()
  const limitId = useId()
  const first = useRef<HTMLInputElement>(null)
  // A name, and the limit, reckon with a folder whose deletion is still held (ADR 0048).
  const known = knownFolders(tables, store.foldersBeforeHolds())
  const canMake = canMakeFolder(known)
  const [choice, setChoice] = useState<string>(() => (canMake ? 'new' : 'none'))
  const [name, setName] = useState(() => folderName(data.blogroll.name))
  const [taken, setTaken] = useState<string | null>(null)
  const folders = [...tables.folders.values()].sort((x, y) =>
    x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }),
  )
  // The limit reached meanwhile, or the folder chosen deleted elsewhere: none, until chosen again.
  const chosen =
    (choice === 'new' && !canMake) ||
    (choice !== 'new' && choice !== 'none' && !tables.folders.has(choice))
      ? 'none'
      : choice

  // The card opens on the choice made; the sheet moves focus into itself.
  useEffect(() => {
    if (!phone) first.current?.focus()
  }, [phone])

  const done = () => {
    onClose()
    opener.current?.focus()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    // The rows as they are now, not as this render saw them: a blog followed since is not
    // subscribed to again, nor moved.
    const now = store.getSnapshot().tables
    let to: Destination = { kind: 'none' }
    if (chosen === 'new') {
      const names = knownFolders(now, store.foldersBeforeHolds())
      if (!canMakeFolder(names)) return
      const checked = checkFolderName(name.trim() === '' ? data.blogroll.name : name, names)
      if ('taken' in checked) {
        setTaken(checked.taken)
        return
      }
      if ('ok' in checked) to = { kind: 'new', id: newId(), name: checked.ok }
    } else if (chosen !== 'none') {
      to = { kind: 'folder', id: chosen }
    }
    const plan = subscribeAllPlan(
      now,
      data.blogs.map((b) => b.feedId),
      to,
    )
    const held = store.mutateMany(plan.inputs, { holdMs: UNDO_HOLD_MS })
    const last = held[held.length - 1]
    done()
    if (!last) return
    const folder =
      to.kind === 'new' ? to.name : to.kind === 'folder' ? now.folders.get(to.id)?.name : undefined
    const one = plan.fresh.length === 1 ? data.blogs.find((b) => b.feedId === plan.fresh[0]) : null
    const what = { n: plan.fresh.length, blog: one ? blogLabel(one) : '' }
    offerUndo(
      store,
      folder ? t('doneIn', { ...what, folder }) : t('done', what),
      tt('undo'),
      held.map((h) => h.mid),
      // Sent already: each blog unsubscribed again, and filed back where it was.
      () =>
        store.mutateMany(undoSubscribeAll(plan, store.getSnapshot().tables), { after: last.at }),
    )
  }

  const option = (value: string, label: string, testId: string, disabled = false) => (
    <label
      className={`flex shrink-0 items-center gap-2.5 py-2 ${disabled ? 'opacity-60' : 'cursor-pointer'} ${phone ? 'min-h-12' : 'min-h-[38px]'}`}
      data-testid={testId}
      data-folder-id={value}
    >
      <input
        ref={value === chosen ? first : undefined}
        type="radio"
        name={`${titleId}-where`}
        value={value}
        checked={chosen === value}
        disabled={disabled}
        aria-describedby={disabled ? limitId : undefined}
        onChange={() => {
          setChoice(value)
          setTaken(null)
        }}
        className="size-4 shrink-0 accent-ink"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </label>
  )

  const body = (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2
        id={titleId}
        className={`m-0 font-serif font-medium ${phone ? 'mt-4 text-[24px]' : 'text-[22px]'}`}
      >
        {t('title', { n: fresh.length })}
      </h2>
      {have.length > 0 ? (
        <p className="-mt-1.5 mb-0 text-[13px] leading-normal text-ink-2 [overflow-wrap:anywhere]">
          <Already have={have} />
        </p>
      ) : null}
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 p-0 text-[12.5px] font-semibold">{t('putIn')}</legend>
        <div className="flex max-h-[236px] flex-col overflow-y-auto border-y border-line px-1 py-1 max-md:max-h-[40dvh]">
          <div className="flex flex-wrap items-center gap-x-2.5">
            {option('new', t('newFolder'), 'subscribe-all-option', !canMake)}
            {chosen === 'new' ? (
              <input
                id={nameId}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setTaken(null)
                }}
                aria-label={t('folderName')}
                aria-invalid={taken !== null}
                aria-describedby={taken !== null ? errorId : undefined}
                className="min-w-[140px] flex-1 rounded-lg border border-thumb bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-muted max-md:mb-2 max-md:text-[16px]"
                data-testid="subscribe-all-folder-name"
              />
            ) : null}
          </div>
          {taken !== null ? (
            <p id={errorId} role="alert" className="m-0 pb-1.5 text-[12.5px] text-danger">
              {tf('taken', { name: taken })}
            </p>
          ) : null}
          {canMake ? null : (
            <p id={limitId} className="m-0 pb-1.5 text-[12.5px] text-muted">
              {tf('limit', { max: MAX_FOLDERS })}
            </p>
          )}
          {folders.map((f) => (
            <div key={f.id} className={phone ? 'border-t border-line' : ''}>
              {option(f.id, f.name, 'subscribe-all-option')}
            </div>
          ))}
          <div className={phone ? 'border-t border-line' : ''}>
            {option('none', tf('none'), 'subscribe-all-option')}
          </div>
        </div>
      </fieldset>
      <p className="m-0 text-[12.5px] leading-normal text-muted">{t('hint')}</p>
      <div className={`flex gap-2 ${phone ? 'mt-1' : 'justify-end'}`}>
        <button
          type="button"
          onClick={done}
          className={
            phone
              ? 'min-h-[46px] flex-1 rounded-full border border-thumb font-medium text-ink hover:border-ink'
              : 'rounded-full px-3 py-[7px] text-[13px] text-muted hover:bg-hover hover:text-ink'
          }
        >
          {t('cancel')}
        </button>
        <button
          type="submit"
          className={
            phone
              ? 'min-h-[46px] flex-[2] rounded-full bg-ink font-medium text-paper hover:brightness-125'
              : 'rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:brightness-125'
          }
          data-testid="subscribe-all-submit"
        >
          {t('submit', { n: fresh.length })}
        </button>
      </div>
    </form>
  )

  if (phone) {
    return (
      <Sheet
        labelledBy={titleId}
        opener={opener}
        onClose={onClose}
        testId="subscribe-all-panel"
        // The page's header centres its text, and a dialog inherits from where it is in the page.
        className="text-left"
      >
        {body}
      </Sheet>
    )
  }
  return (
    <section
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          done()
        }
      }}
      className="w-full max-w-[520px] animate-fade rounded-xl border border-line bg-surface p-5 text-left"
      data-testid="subscribe-all-panel"
    >
      {body}
    </section>
  )
}
