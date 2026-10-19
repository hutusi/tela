/**
 * The article itself. Everything comes from the device: the row from the local store, the body
 * from IndexedDB (prefetched, usually) or the edge. Opening one therefore costs no request to
 * tela-api at all (ADR 0025). Highlights, notes and typography are the member's synced rows and
 * prefs (ADR 0026).
 */
import { COMMUNITY_LISTING_MIN_READERS } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useLocale, useTranslations } from 'use-intl'
import { mergeAnchors } from '../lib/anchor'
import { pairBlocks, readerBlocks, runsOf, translatedPrefix } from '../lib/block-pairs'
import { relativeTime } from '../lib/format'
import { pointAt, renderedLeaves, type Side } from '../lib/highlight-dom'
import type { ReadingMode } from '../lib/href'
import { newId } from '../lib/id'
import { lazyImages } from '../lib/lazy-images'
import { useReadingPrefs } from '../lib/prefs'
import { readerStyle, typographyOf } from '../lib/typography'
import { useHighlights } from '../lib/use-highlights'
import { BELOW_LG, useMediaQuery } from '../lib/use-media'
import { useQuickPull } from '../lib/use-quick-pull'
import { useArticleTranslation } from '../lib/use-translation'
import { useNow, useStore, useTables } from '../store/hooks'
import type { ContentObject } from '../store/objects'
import {
  feedTitle,
  isLiked,
  isRecommended,
  shownRead,
  shownTitle,
  siteOfFeed,
} from '../store/selectors'
import { FocusToggle } from './focus-toggle'
import { CLOSE, Glyph } from './glyph'
import { HighlightList, HighlightNote, HighlightToolbar, useSelectedAnchor } from './highlights'
import { LikeButton } from './like-button'
import { PairedBody } from './paired-body'
import { ReaderBackBar, ReaderBottomBar, RecommendSheet } from './reader-phone'
import {
  RecommendButton,
  RecommendForm,
  RecommendPopover,
  useUnrecommend,
} from './recommend-popover'
import { SiteAvatar } from './site-avatar'
import { ReaderPaneSkeleton } from './skeletons'
import { Swatch } from './swatch'
import { TranslationBar } from './translation-bar'
import { TypographyMenu } from './typography-menu'
import { TranslatingRest, Untranslated } from './untranslated'

function Body({
  html,
  lang,
  dir,
  testId,
}: {
  html: string
  lang?: string | undefined
  dir?: 'auto' | undefined
  testId: string
}) {
  // Its images load as they near the screen, not all as the post opens.
  const lazy = useMemo(() => lazyImages(html), [html])
  return (
    <div
      className="article-body"
      lang={lang}
      dir={dir}
      data-testid={testId}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; model output re-escaped on rehydration (ADR 0005)
      dangerouslySetInnerHTML={{ __html: lazy }}
    />
  )
}

type Props = {
  article: ArticleRow
  readingLang: string
  mode: ReadingMode
  onMode: (mode: ReadingMode) => void
  onClose: () => void
  /** The post after this one in the list as shown, if any: offered at the end of the article. */
  next: { href: string; title: string; lang?: string | undefined; blog: string } | null
  /** What the list it was opened from is called: a phone's back bar goes back to it by name. */
  listName: string
}

/**
 * Where the one Recommend form is open: the toolbar's popover or the box at the article's end, or
 * on a phone the bottom sheet.
 */
type Recommending = 'top' | 'end' | 'sheet' | null

/** The end of the article is one column whatever the body above it: the measure, at most 680px. */
const END = 'max-w-[min(680px,var(--reader-measure))]'

export function Reader({ article, readingLang, mode, onMode, onClose, next, listName }: Props) {
  const t = useTranslations('reader')
  const locale = useLocale()
  const now = useNow()
  const tables = useTables()
  const { objects, engine, store } = useStore()
  // `failed` when the body could not be fetched (offline, an error), as opposed to a post that has
  // none: the one is worth trying again, the other is not.
  const [content, setContent] = useState<{
    key: string
    object: ContentObject | null
    failed?: true
  } | null>(null)
  const key = article.contentKey
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    objects
      .body(key, controller.signal)
      .then((object) => setContent({ key, object }))
      .catch(() => !controller.signal.aborted && setContent({ key, object: null, failed: true }))
    return () => controller.abort()
  }, [key, objects, attempt])
  const bodyFailed = content?.key === key && content.failed === true
  // Try again: the skeleton while it asks, as on opening.
  const retryBody = useCallback(() => {
    setContent(null)
    setAttempt((n) => n + 1)
  }, [])
  // Back online, a body that failed is asked for again by itself.
  useEffect(() => {
    if (!bodyFailed) return
    window.addEventListener('online', retryBody)
    return () => window.removeEventListener('online', retryBody)
  }, [bodyFailed, retryBody])

  // While a summary-only post waits for its full text, pull quickly so it appears when it lands.
  const extracting = article.extractState === 'due'
  useQuickPull(extracting ? `extract:${article.id}` : null, () => void engine.pull())

  const object = content?.key === key ? content.object : null
  const loaded = !key || content?.key === key
  // Focus moves in once the article is on screen, not while its skeleton is: focusing the pane
  // before that focused nothing, and a keyboard reader was left in the list.
  const pane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (loaded) pane.current?.focus({ preventScroll: true })
  }, [loaded])
  // Translated on opening, or only once asked (a pref), and never in a language the member reads
  // as written. The Reader is keyed by the article, so asking lasts for this post.
  const prefs = useReadingPrefs(tables)
  const [asked, setAsked] = useState(false)
  const wanted = prefs.autoTranslate || asked
  const translation = useArticleTranslation(article, object, readingLang, {
    enabled: wanted,
    never: prefs.never,
  })
  const original = useMemo(() => (object ? readerBlocks(object) : []), [object])
  const pairs = useMemo(
    () =>
      translation.blocks ? pairBlocks(translation.blocks, original, translation.untranslated) : [],
    [translation.blocks, original, translation.untranslated],
  )

  const view = translation.view
  const shown: ReadingMode = view?.available && wanted ? mode : 'orig'
  // What Translation mode shows while chunks are still landing: up to the first gap, then a
  // placeholder. Side by side keeps every row, with the source standing in for what is missing.
  const state = view?.state ?? 'none'
  const prefix = useMemo(() => translatedPrefix(pairs, state), [pairs, state])
  const [recommending, setRecommending] = useState<Recommending>(null)
  const unrecommend = useUnrecommend()
  // A phone has a back bar and a bar of actions in place of the toolbar (Tela Mobile).
  const phone = useMediaQuery(BELOW_LG)
  const barRecommend = useRef<HTMLButtonElement>(null)
  const endRecommend = useRef<HTMLButtonElement>(null)

  // Highlights: painted over what is rendered, found again after the post changes (ADR 0026).
  const body = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<{ id: string; x: number; y: number } | null>(null)
  // Settled once it is finished and on screen in full: a synced row can say done while the final
  // object is still loading, and a block still in source text would take an anchor meant for the
  // translation.
  const translationSettled =
    (state === 'done' || state === 'partial') && !pairs.some((p) => p.pending)
  const rendered = useMemo(() => ({ shown, object, pairs }), [shown, object, pairs])
  // The post's leaves in order, which the list of highlights follows: both sides share the ids.
  const leafOrder = useMemo(
    () => new Map((object?.blocks ?? []).flatMap((b) => b.leaves).map((id, i) => [id, i])),
    [object],
  )
  const highlights = useHighlights({
    article,
    root: body,
    readingLang,
    order: leafOrder,
    rendered,
    translationSettled,
    activeId: note?.id ?? null,
  })
  const selected = useSelectedAnchor(body)
  // A streaming translation's text is still changing: highlight it once it has settled.
  const selectable =
    selected && (selected.side === 'original' || translationSettled) ? selected : null
  // A selection that overlaps or touches highlights in its leaf takes them in: one highlight over
  // all of it, with their notes, under a new id. A new id because a deleted one stays deleted, and
  // another device's re-anchoring could still write to an old one and undo the merge. Inside one
  // already, it changes nothing, and Add a note opens that one's note.
  const { inLeaf } = highlights
  const highlight = useCallback(
    (side: Side, withNote: boolean) => {
      if (!selectable || !article.contentKey || !body.current) return
      const { anchor, rect } = selectable
      const lang = side === 'translation' ? readingLang : null
      const text = renderedLeaves(body.current, side).get(anchor.leafId)?.textContent ?? ''
      const spans = inLeaf(side, lang, anchor.leafId).map((item) => ({
        id: item.row.id,
        start: item.start,
        end: item.end,
        note: item.row.note,
      }))
      const merge = text ? mergeAnchors(anchor.leafId, text, anchor, spans) : null
      window.getSelection()?.removeAllRanges()
      const at = { x: rect.left + rect.width / 2, y: rect.bottom }
      if (merge?.kind === 'inside') {
        if (withNote) setNote({ id: merge.id, ...at })
        return
      }
      const id = newId()
      const put = {
        type: 'putHighlight' as const,
        id,
        articleId: article.id,
        contentKey: article.contentKey,
        side,
        lang,
        ...(merge ? merge.anchor : anchor),
        note: merge?.note ?? null,
      }
      if (merge) {
        const { absorbed } = merge
        store.mutateMany([
          put,
          ...absorbed.map((gone) => ({ type: 'deleteHighlight' as const, id: gone })),
        ])
        // A note open on one it took in is now the merged one's.
        setNote((open) => (open && absorbed.includes(open.id) ? { ...open, id } : open))
      } else store.mutate(put)
      if (withNote) setNote({ id, ...at })
    },
    [selectable, article.id, article.contentKey, readingLang, store, inLeaf],
  )
  // `h` highlights the selection: the keyboard's way to the toolbar.
  useEffect(() => {
    if (!selectable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      highlight(selectable.side, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectable, highlight])
  const noteRow = note ? tables.highlights.get(note.id) : undefined
  const closeNote = useCallback(() => setNote(null), [])

  if (!loaded) return <ReaderPaneSkeleton />

  const { size, measure } = typographyOf(tables)
  // A click on painted text opens that highlight's note; a click on a link inside it still follows
  // the link. The list below the article is the keyboard's way to the same popover.
  const onBodyClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('a') || !window.getSelection()?.isCollapsed) return
    const point = pointAt(e.clientX, e.clientY)
    const row = point ? highlights.at(point.side, point.leafId, point.offset) : undefined
    if (row) setNote({ id: row.id, x: e.clientX, y: e.clientY })
  }
  const showTrans = shown !== 'orig'
  const twoCols = shown === 'side'
  const sourceLang = article.sourceLang ?? undefined
  const name = feedTitle(tables, article.feedId) || store.sourceName(article.feedId)
  const site = siteOfFeed(tables, article.feedId)
  const titles = shownTitle(tables, article, readingLang, prefs.never)
  const read = shownRead(tables, article, now, true, prefs.markOnOpen)
  const title = showTrans ? titles.title : article.title
  const runs = showTrans
    ? runsOf(prefix.pairs, 'translated')
    : [{ id: 'o', html: original.map((b) => b.html).join(''), untranslated: false, pending: false }]
  const liked = isLiked(tables, article.id)
  const recommended = isRecommended(tables, article.id)
  const recommendNote = tables.recommendations.get(article.id)?.note ?? null
  // A count below three says who else reads it, as public pages do not (ADR 0041).
  const readers = site?.readerCount ?? 0
  const about = [
    site?.description,
    readers >= COMMUNITY_LISTING_MIN_READERS ? t('readersOnTela', { n: readers }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  // Mark as unread on a read post, Mark as read on an unread one, whatever the pref: a phone has
  // no `m`, so its bar's button is its only way back to unread. One button whose label turns, so
  // focus stays on it, and it sends what the label says.
  const toggleRead = () =>
    store.mutate({ type: read ? 'markUnread' : 'markRead', articleId: article.id })

  return (
    <main
      ref={pane}
      // The foot clears the phone's bar of actions while it shows (`--bottom-bar`).
      className="min-w-0 overflow-hidden px-5 pb-[calc(5rem+var(--bottom-bar,0px))] pt-6 outline-none animate-fade md:px-8"
      data-testid="reader"
      data-mode={shown}
      data-size={size}
      data-measure={measure}
      style={readerStyle(size, measure)}
      tabIndex={-1}
    >
      {phone ? <ReaderBackBar listName={listName} onBack={onClose} /> : null}
      {extracting ? (
        <p className="mx-auto mb-4 max-w-[1240px] text-[13px] text-muted" data-testid="extracting">
          {t('fetchingFullText')}
        </p>
      ) : null}

      {phone ? null : (
        <div className="mx-auto mb-7 flex max-w-[1240px] flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className="-ml-2.5 flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink"
              data-testid="close-article"
            >
              <Glyph size={14} className="shrink-0">
                {CLOSE}
              </Glyph>
              {t('close')}
            </button>
            <FocusToggle />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={toggleRead}
              className="whitespace-nowrap rounded-full border border-thumb px-3.5 py-[7px] font-medium text-ink hover:border-ink"
              data-testid={read ? 'mark-unread' : 'mark-read'}
            >
              {t(read ? 'markUnread' : 'markRead')}
            </button>
            <TypographyMenu />
            <LikeButton articleId={article.id} liked={liked} likeCount={article.likeCount} />
            <RecommendPopover
              articleId={article.id}
              recommended={recommended}
              note={recommendNote}
              recommendCount={article.recommendCount}
              open={recommending === 'top'}
              onOpenChange={(open) => setRecommending(open ? 'top' : null)}
            />
          </div>
        </div>
      )}

      {/* The column, centred: the measure while there is one column, and 1240px once the pane has
          room for two paired ones, so the meta line, the bar and the author card are as wide as
          the text under them. The container is a wrapper of its own because container-type brings
          layout containment, which makes it the containing block for `fixed` descendants: the
          highlight toolbar and note stay outside it, or they would be placed within this column. */}
      <div className="@container">
        <div
          className={`mx-auto max-w-(--reader-measure) ${twoCols ? '@min-[1040px]:max-w-[1240px]' : ''}`}
        >
          <div className="mb-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted">
            <Swatch id={article.feedId} title={name} size={22} />
            <span className="font-medium text-ink">{name}</span>
            {article.author ? (
              <>
                <span>·</span>
                <span>{article.author}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{relativeTime(article.publishedAt ?? article.fetchedAt, locale, now)}</span>
            <span>·</span>
            <span>{t('minRead', { n: article.readingMinutes || 1 })}</span>
            {article.url ? (
              <>
                <span>·</span>
                <a href={article.url} target="_blank" rel="noopener noreferrer">
                  {t('readOriginal')} ↗
                </a>
              </>
            ) : null}
          </div>

          {view && sourceLang ? (
            <TranslationBar
              sourceLang={sourceLang}
              view={view}
              mode={mode}
              onMode={onMode}
              onTranslate={wanted ? undefined : () => setAsked(true)}
              onRetry={
                state === 'failed' || translation.notice === 'unavailable'
                  ? translation.retry
                  : undefined
              }
            />
          ) : null}
          {translation.notice ? (
            <p
              className="mb-7 text-[13px] text-muted"
              data-testid={`translation-${translation.notice}`}
            >
              <TranslationNotice notice={translation.notice} />
            </p>
          ) : null}

          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut to a highlight's note; the list below reaches the same popover by keyboard */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: as above */}
          <div ref={body} onClick={onBodyClick}>
            {twoCols ? (
              <PairedBody
                pairs={prefix.rest ? pairs : prefix.pairs}
                title={titles.title}
                originalTitle={article.title}
                targetLang={readingLang}
                sourceLang={sourceLang}
              />
            ) : (
              <div className="max-w-(--reader-measure)">
                <h1
                  className="mb-6 font-serif text-[30px] font-medium leading-[1.12] tracking-tight lg:text-[40px]"
                  style={{ textWrap: 'pretty' }}
                  lang={showTrans ? titles.lang : sourceLang}
                  data-testid="article-title"
                >
                  {title}
                </h1>
                {object && original.length > 0 ? (
                  <>
                    {runs.map((run) =>
                      run.untranslated ? (
                        <Untranslated key={run.id} pending={run.pending} sourceLang={sourceLang}>
                          <Body
                            html={run.html}
                            lang={sourceLang}
                            dir="auto"
                            testId="body-translated"
                          />
                        </Untranslated>
                      ) : (
                        <Body
                          key={run.id}
                          html={run.html}
                          lang={showTrans ? readingLang : sourceLang}
                          dir={showTrans ? undefined : 'auto'}
                          testId={showTrans ? 'body-translated' : 'body-original'}
                        />
                      ),
                    )}
                    {showTrans && prefix.rest ? <TranslatingRest /> : null}
                  </>
                ) : bodyFailed ? (
                  // Not "no readable content": the post has some, and it did not come.
                  <div className="text-[15px] text-muted" data-testid="body-failed">
                    <p className="m-0">{t('loadFailed')}</p>
                    <p className="mt-2.5 mb-0 flex flex-wrap items-center gap-x-5 gap-y-2">
                      <button
                        type="button"
                        onClick={retryBody}
                        className="underline hover:text-ink"
                        data-testid="body-retry"
                      >
                        {t('retry')}
                      </button>
                      {article.url ? (
                        <a href={article.url} target="_blank" rel="noopener noreferrer">
                          {t('readOriginal')} ↗
                        </a>
                      ) : null}
                    </p>
                  </div>
                ) : (
                  <p className="text-muted">{t('noContent')}</p>
                )}
              </div>
            )}
          </div>

          <HighlightList
            items={highlights.items}
            onOpen={(item, at) => setNote({ id: item.row.id, x: at.x, y: at.y })}
          />

          {/* The end of the article (Tela v5): what the reader can do with it, which the author
              sees, then whose it is, then what comes next. On a phone the bar at the foot holds
              Like and Recommend, so only what the author sees is said here. */}
          <div
            className={`mt-10 flex ${END} flex-wrap items-center gap-2 border-t border-line pt-6`}
            data-testid="end-actions"
          >
            {phone ? null : (
              <>
                <LikeButton articleId={article.id} liked={liked} testId="end-like" />
                <RecommendButton
                  ref={endRecommend}
                  recommended={recommended}
                  testId="end-recommend"
                  onClick={() =>
                    recommended
                      ? unrecommend(article.id)
                      : setRecommending((at) => (at === 'end' ? null : 'end'))
                  }
                />
              </>
            )}
            <span
              className={`${phone ? '' : 'ml-2'} flex-[1_1_220px] text-[13px] leading-[1.45] text-muted`}
              style={{ textWrap: 'pretty' }}
            >
              {t('visibleToAuthor')}
            </span>
          </div>
          {recommending === 'end' && !recommended && !phone ? (
            <section
              aria-label={t('recommendTitle')}
              className={`mt-3 ${END} rounded-xl border border-line bg-surface p-3.5 animate-fade`}
              data-testid="recommend-inline"
            >
              <RecommendForm
                articleId={article.id}
                note={recommendNote}
                onClose={() => {
                  setRecommending(null)
                  endRecommend.current?.focus()
                }}
              />
            </section>
          ) : null}

          <div
            className={`mt-8 flex ${END} flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-6`}
            data-testid="end-blog"
          >
            {site ? (
              <SiteAvatar id={site.id} title={name} faviconKey={site.faviconKey} size={44} round />
            ) : (
              <Swatch id={article.feedId} title={name} size={44} round />
            )}
            <div className="min-w-[200px] flex-1">
              {/* The name the list and the meta line use (`feedTitle`): a blog's, or its feed's
                  own where the device holds two feeds of one blog. */}
              <div className="font-medium">{name}</div>
              {about ? <div className="text-[13px] text-muted">{about}</div> : null}
            </div>
          </div>

          {/* A push like a row click: the key on the Reader remounts it at the top of the next one. */}
          {next ? (
            <Link
              to={next.href}
              data-testid="next-article"
              className={`mt-6 flex ${END} flex-col gap-1 rounded-[10px] border border-line px-4 py-3 text-ink hover:bg-hover hover:no-underline`}
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                {t('upNext', { blog: next.blog })}
              </span>
              <span
                className="font-serif text-[19px] font-medium leading-[1.2] tracking-tight"
                style={{ textWrap: 'pretty' }}
                lang={next.lang}
              >
                {next.title}
              </span>
            </Link>
          ) : null}
        </div>
      </div>

      {phone ? (
        <ReaderBottomBar
          liked={liked}
          likeCount={article.likeCount}
          onLike={() => store.mutate({ type: 'setLiked', articleId: article.id, liked: !liked })}
          recommended={recommended}
          onRecommend={() => (recommended ? unrecommend(article.id) : setRecommending('sheet'))}
          recommendRef={barRecommend}
          read={read}
          onRead={toggleRead}
          url={article.url}
        />
      ) : null}
      {phone && recommending === 'sheet' && !recommended ? (
        <RecommendSheet
          articleId={article.id}
          note={recommendNote}
          post={`${titles.title} · ${site?.title ?? name}`}
          opener={barRecommend}
          onClose={() => setRecommending(null)}
        />
      ) : null}
      {selectable ? (
        <HighlightToolbar
          selected={selectable}
          onHighlight={(withNote) => highlight(selectable.side, withNote)}
        />
      ) : null}
      {noteRow && note ? (
        <HighlightNote key={noteRow.id} row={noteRow} at={note} onClose={closeNote} />
      ) : null}
    </main>
  )
}

function TranslationNotice({
  notice,
}: {
  notice: 'rateLimited' | 'budgetExhausted' | 'unavailable'
}) {
  const t = useTranslations('translation')
  return <>{t(notice)}</>
}
