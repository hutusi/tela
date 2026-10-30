/**
 * Add blogs to the member's own blogroll from their subscriptions (ADR 0050, Tela Lists): a card
 * under the blogroll's header from `md`, a bottom sheet below. Every blog they follow, by name,
 * filtered by name or address as Settings filters them, each a tick box: ticking puts it in the
 * blogroll and unticking takes it out, at once and with no Undo, since the box itself undoes it.
 * Once the blogroll holds as many blogs as it may, the boxes not ticked are disabled and it says
 * why. A blog left later stays in the blogroll, and the card says so.
 */
import { MAX_BLOGROLL_BLOGS } from '@tela/shared'
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { blogsCounted } from '../lib/blogrolls'
import { blogAddress } from '../lib/format'
import { matcher } from '../lib/subscriptions'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { liveBlogs } from '../store/blogrolls'
import { useStore, useTables } from '../store/hooks'
import { feedTitle } from '../store/selectors'
import { CHECK, Glyph, SEARCH } from './glyph'
import { Sheet } from './sheet'
import { SiteAvatar } from './site-avatar'

export function AddBlogs({
  blogrollId,
  opener,
  onClose,
}: {
  blogrollId: string
  /** Add blogs, which focus goes back to once it closes. */
  opener: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const t = useTranslations('blogroll.add')
  const phone = useMediaQuery(BELOW_MD)
  const titleId = useId()
  if (phone) {
    return (
      <Sheet
        labelledBy={titleId}
        opener={opener}
        onClose={onClose}
        testId="add-blogs"
        className="text-left"
      >
        <h2 id={titleId} className="mt-4 mb-3 font-serif text-[24px] leading-tight font-medium">
          {t('title')}
        </h2>
        <AddBlogsBody blogrollId={blogrollId} onDone={onClose} phone />
      </Sheet>
    )
  }
  // The card goes from under the focus: it goes back to Add blogs, which stays.
  const close = () => {
    onClose()
    opener.current?.focus()
  }
  return (
    <section
      aria-labelledby={titleId}
      // Esc closes the card, once the filter has had it (an Esc that clears it is handled there).
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          close()
        }
      }}
      className="flex w-full max-w-[520px] animate-fade flex-col rounded-xl border border-line bg-surface p-3 text-left"
      data-testid="add-blogs"
    >
      <h2 id={titleId} className="m-0 px-2 pt-1.5 pb-2 text-[13.5px] font-semibold">
        {t('title')}
      </h2>
      <AddBlogsBody blogrollId={blogrollId} onDone={close} phone={false} />
    </section>
  )
}

function AddBlogsBody({
  blogrollId,
  onDone,
  phone,
}: {
  blogrollId: string
  onDone: () => void
  phone: boolean
}) {
  const t = useTranslations('blogroll.add')
  const { store } = useStore()
  const tables = useTables()
  const [query, setQuery] = useState('')
  const filter = useRef<HTMLInputElement>(null)
  const limitId = useId()
  // The card opens to be typed in; the sheet puts focus on its first control itself.
  useEffect(() => {
    if (!phone) filter.current?.focus()
  }, [phone])

  const rows = useMemo(
    () =>
      [...tables.subscriptions.values()]
        .filter((s) => s.deletedAt === null)
        .map((s) => {
          const feed = tables.feeds.get(s.feedId)
          const site = feed ? tables.sites.get(feed.siteId) : undefined
          return {
            feedId: s.feedId,
            title: feedTitle(tables, s.feedId) || '…',
            host: site ? blogAddress(site.homeUrl) : null,
            feedUrl: feed?.feedUrl ?? null,
            site,
          }
        })
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
    [tables],
  )
  const inIt = useMemo(
    () => new Set(liveBlogs(tables, blogrollId).map((b) => b.feedId)),
    [tables, blogrollId],
  )
  // A blog whose removal is held keeps its place under the limit until the removal goes.
  const full = useMemo(
    () => blogsCounted(tables, store.tablesBeforeHolds(), blogrollId) >= MAX_BLOGROLL_BLOGS,
    [tables, store, blogrollId],
  )
  const matches = matcher(query)
  const shown = rows.filter((r) => matches([r.title, r.host, r.feedUrl]))

  const toggle = (feedId: number, on: boolean) => {
    // Asked of the rows as they are now: a second tick before the render must not pass the limit.
    const now = store.getSnapshot().tables
    if (on && blogsCounted(now, store.tablesBeforeHolds(), blogrollId) >= MAX_BLOGROLL_BLOGS) return
    store.mutate(
      on ? { type: 'rollBlog', blogrollId, feedId } : { type: 'unrollBlog', blogrollId, feedId },
    )
  }

  return (
    <>
      <label
        className={`mx-1 mb-2 flex items-center gap-2 rounded-full border border-line bg-paper px-3 text-muted focus-within:border-muted ${phone ? 'min-h-11' : 'h-9'}`}
      >
        <Glyph size={13} className="shrink-0">
          {SEARCH}
        </Glyph>
        <input
          ref={filter}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc clears the filter first; an empty one lets Esc close the sheet.
            if (e.key === 'Escape' && query !== '') {
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
            }
          }}
          placeholder={t('filter')}
          aria-label={t('filterLabel')}
          className={`min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none placeholder:text-muted ${phone ? 'text-[16px]' : 'text-[13px]'}`}
          data-testid="add-blogs-filter"
        />
      </label>
      {full ? (
        <p
          id={limitId}
          className="m-0 px-2 pb-2 text-[12.5px] text-muted"
          data-testid="add-blogs-limit"
        >
          {t('limit', { max: MAX_BLOGROLL_BLOGS })}
        </p>
      ) : null}
      <ul
        className={`m-0 flex list-none flex-col border-y border-line p-0 py-1 ${phone ? 'max-h-[50dvh]' : 'max-h-[304px]'} overflow-y-auto`}
      >
        {shown.map((r) => {
          const on = inIt.has(r.feedId)
          const disabled = !on && full
          return (
            <li key={r.feedId}>
              {/* `relative` holds the hidden box to its row. Without it the box is placed as if the
                  list had not scrolled, so ticking a row far down scrolled the page to it. */}
              <label
                className={`relative flex items-center gap-2.5 rounded-lg px-2 text-ink ${phone ? 'min-h-12' : 'py-2'} ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-hover'}`}
                data-testid="add-blogs-item"
                data-feed-id={r.feedId}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  aria-describedby={disabled ? limitId : undefined}
                  onChange={(e) => toggle(r.feedId, e.target.checked)}
                  className="peer sr-only"
                />
                {/* The box as the design draws it, ringed while the real one has focus. */}
                <span
                  aria-hidden="true"
                  className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] text-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${on ? 'border-ink bg-ink' : 'border-thumb bg-transparent'}`}
                >
                  {on ? (
                    <Glyph size={12} strokeWidth={2} className="block">
                      {CHECK}
                    </Glyph>
                  ) : null}
                </span>
                <SiteAvatar
                  id={r.site?.id ?? r.feedId}
                  title={r.title}
                  faviconKey={r.site?.faviconKey ?? null}
                  size={20}
                  radius={5}
                />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
              </label>
            </li>
          )
        })}
        {shown.length === 0 ? (
          <li
            className="px-2 py-5 text-center text-[13px] text-muted"
            data-testid="add-blogs-empty"
          >
            {rows.length === 0 ? t('none') : t('noMatch')}
          </li>
        ) : null}
      </ul>
      <div
        className={`flex items-center gap-3 px-1 pt-2.5 ${phone ? 'flex-col items-stretch' : 'pb-0.5'}`}
      >
        <span className="flex-1 text-[12px] leading-[1.45] text-muted">{t('hint')}</span>
        <button
          type="button"
          onClick={onDone}
          className={`rounded-full bg-ink px-4 py-[7px] text-[13px] font-medium text-paper hover:brightness-125 ${phone ? 'min-h-[46px] text-[14px]' : ''}`}
          data-testid="add-blogs-done"
        >
          {t('done')}
        </button>
      </div>
    </>
  )
}
