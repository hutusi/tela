/**
 * `/l/:id` (ADR 0050). The owner's blogroll renders from the local store; anyone else's from
 * tela-api's public answer. In order:
 *
 * 1. An id of the wrong shape is not a blogroll: Not found, with no request.
 * 2. One the device holds is the member's own (blogrolls sync to their owner only): their page,
 *    with its tools, from the store. No public request, which a private one would answer 404.
 * 3. One whose deletion is held while its Undo shows is gone: Not found, not the public copy.
 * 4. Anything else is asked of tela-api: a member sees Subscribe on it, a guest sign-in links.
 *    The owner on a device that has not pulled it yet sees it as others do, with nothing to press.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { useTranslations } from 'use-intl'
import type { BlogrollPageState } from '../components/blogroll-dialog'
import { BlogrollNote } from '../components/blogroll-note'
import { BlogrollOwner } from '../components/blogroll-owner'
import { SubscribeAll } from '../components/subscribe-all'
import { blogrollPath, isBlogrollId } from '../lib/blogroll-href'
import { blogLabel } from '../lib/blogrolls'
import { useMemberControls } from '../lib/member'
import { useTitle } from '../lib/title'
import { UNDO_HOLD_MS } from '../lib/toasts'
import { offerUndo } from '../lib/undo'
import { usePublic } from '../lib/use-public'
import { selectBlogrollPage } from '../store/blogrolls'
import { useNow, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { BlogrollView, QUIET_PILL, ROW_PILL } from '../views/blogroll'
import { blogrollDataOf } from '../views/public-data'
import type { BlogrollBlog, BlogrollData, Person } from '../views/types'
import { NotFoundPage } from './not-found'

export function BlogrollPage() {
  const raw = useParams().id
  const id = isBlogrollId(raw) ? raw : null
  const { store } = useStore()
  const tables = useTables()
  const own = id === null ? undefined : tables.blogrolls.get(id)
  // A deletion held for its Undo: the view has let the blogroll go, the tables before holds have
  // not. Asked only when the view does not hold it, and once per change of the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view changes when a hold is made or taken back
  const heldGone = useMemo(
    () => id !== null && own === undefined && store.tablesBeforeHolds().blogrolls.has(id),
    [id, own, store, tables],
  )
  const loaded = usePublic<BlogrollData>(
    id !== null && own === undefined && !heldGone ? blogrollPath(id) : null,
  )
  const data = loaded.status === 'ready' ? blogrollDataOf(loaded.data) : null
  useTitle(own ? own.name : data ? data.blogroll.name : null)

  if (id === null) return <NotFoundPage />
  if (heldGone) return <HeldBlogroll id={id} />
  if (own) return <OwnBlogroll id={id} />
  if (loaded.status === 'missing') return <NotFoundPage />
  if (!data) return <main className="flex-1" aria-busy="true" />
  return <OthersBlogroll data={data} />
}

/** Someone else's public blogroll, or the member's own before this device holds it. */
function OthersBlogroll({ data }: { data: BlogrollData }) {
  const member = useMemberControls()
  const { store } = useStore()
  const { locale } = useUi()
  const now = useNow()
  // The owner, on a device that has not pulled the blogroll yet: theirs, but not from the store.
  const readOnly = member !== undefined && store.userId === data.owner.id
  return (
    <BlogrollView
      data={data}
      member={readOnly ? undefined : member}
      locale={locale}
      now={now}
      readOnly={readOnly}
      subscribe={member && !readOnly ? <SubscribeAll data={data} /> : undefined}
    />
  )
}

/** The member as their own blogroll names its owner. */
function useOwner(): Person {
  const { store } = useStore()
  const profile = useTables().profile
  return useMemo(
    () => ({
      id: store.userId ?? '',
      handle: profile?.handle ?? '',
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
    }),
    [store.userId, profile?.handle, profile?.displayName, profile?.avatar],
  )
}

/**
 * The member's own blogroll while its deletion is held for Undo: as it was, with no tools. Not
 * Not found, which the tab that deleted it would paint for a frame before its navigation to the
 * profile lands (a store change renders at once, a navigation in a transition), and which would
 * greet a Back to it while the Undo still stands.
 */
function HeldBlogroll({ id }: { id: string }) {
  const { store } = useStore()
  useTables()
  const { locale } = useUi()
  const now = useNow()
  const owner = useOwner()
  const page = selectBlogrollPage(store.tablesBeforeHolds(), id, owner)
  if (!page) return <NotFoundPage />
  return <BlogrollView data={page.data} locale={locale} now={now} readOnly />
}

/** The member's own blogroll, from the device's rows, with its tools. */
function OwnBlogroll({ id }: { id: string }) {
  const t = useTranslations('blogroll')
  const tt = useTranslations('toast')
  const { store } = useStore()
  const tables = useTables()
  const { locale } = useUi()
  const now = useNow()
  const location = useLocation()
  const owner = useOwner()
  const page = selectBlogrollPage(tables, id, owner)
  const row = tables.blogrolls.get(id)
  // A blogroll just made with nothing in it opens with Add blogs (its page is told so). Only while
  // it is still empty: the flag stays in the history entry, and a Back or a reload after blogs
  // went in should not open the panel, or on a phone its sheet, over them again.
  const [adding, setAdding] = useState(
    () =>
      (location.state as BlogrollPageState | null)?.addBlogs === true &&
      (page?.data.blogs.length ?? 0) === 0,
  )
  const addButton = useRef<HTMLButtonElement>(null)

  // Once a removed blog's row has gone, focus goes to the next row's Remove, or to Add blogs.
  const refocus = useRef<{ removed: number; next: number | null } | null>(null)
  const blogs = page?.data.blogs
  useLayoutEffect(() => {
    const was = refocus.current
    if (!was || !blogs || blogs.some((b) => b.feedId === was.removed)) return
    refocus.current = null
    const next =
      was.next === null
        ? null
        : document.querySelector<HTMLElement>(
            `[data-testid="blogroll-row"][data-feed-id="${was.next}"] [data-testid="blogroll-remove"]`,
          )
    ;(next ?? addButton.current)?.focus()
  }, [blogs])

  if (!page || !row) return null

  const remove = (blog: BlogrollBlog) => {
    const order = page.data.blogs.map((b) => b.feedId)
    const at = order.indexOf(blog.feedId)
    refocus.current = { removed: blog.feedId, next: order[at + 1] ?? order[at - 1] ?? null }
    const held = store.mutate(
      { type: 'unrollBlog', blogrollId: id, feedId: blog.feedId },
      { holdMs: UNDO_HOLD_MS },
    )
    if (!held) return
    // Sent already: put back, after the removal, at the end of the list, with its note.
    offerUndo(store, t('removed', { name: blogLabel(blog) }), tt('undo'), [held.mid], () =>
      store.mutateMany([{ type: 'rollBlog', blogrollId: id, feedId: blog.feedId }], {
        after: held.at,
      }),
    )
  }

  return (
    <BlogrollView
      data={page.data}
      locale={locale}
      now={now}
      ownerHeader={
        <BlogrollOwner row={row} adding={adding} onAdding={setAdding} addButton={addButton} />
      }
      ownerRow={(blog) => {
        const flags = page.flags.get(blog.feedId)
        const said = [
          flags?.notSubscribed ? t('notInSubscriptions') : null,
          flags?.hiddenFromOthers ? t('hiddenFromOthers') : null,
        ].filter(Boolean)
        const name = blogLabel(blog)
        return {
          meta: said.length > 0 ? said.join(' · ') : undefined,
          note: (
            <BlogrollNote
              blogrollId={id}
              feedId={blog.feedId}
              name={name}
              note={blog.note}
              owner={owner}
            />
          ),
          action: (
            <button
              type="button"
              onClick={() => remove(blog)}
              aria-label={t('removeLabel', { name })}
              className={`${ROW_PILL} border-thumb`}
              data-testid="blogroll-remove"
            >
              {t('remove')}
            </button>
          ),
        }
      }}
      empty={
        <div
          className="my-10 flex flex-col items-center gap-3 text-center"
          data-testid="blogroll-empty"
        >
          <p className="m-0 font-serif text-[22px] font-medium">{t('emptyOwner')}</p>
          <p className="m-0 max-w-[420px] text-[14px] text-muted">{t('emptyOwnerHint')}</p>
          {adding ? null : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={QUIET_PILL}
              data-testid="blogroll-empty-add"
            >
              {t('owner.addBlogs')}
            </button>
          )}
        </div>
      }
      footer={row.isPublic ? t('owner.footerPublic') : t('owner.footerPrivate')}
    />
  )
}
