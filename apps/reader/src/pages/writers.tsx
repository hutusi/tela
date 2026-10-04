/**
 * `/writers` (For writers): a writer's calling card, made as they type. Beside the form is a
 * sample card, labelled as one (`lib/sample-card.ts`, ADR 0037), and the sections under it draw
 * from the same sample; every line of the page says only what Tela does today. "Claim your card"
 * opens the sheet in claim mode, which makes the card on the way in and goes on to claim the blog
 * (`lib/claim-card.ts`). A member gets the ways on to their card and their blog instead. SPA-only,
 * and noindex with the rest of the beta (ADR 0035).
 */
import { HANDLE, RESERVED_HANDLES } from '@tela/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useFrontDoor } from '../components/front-door'
import { PersonAvatar } from '../components/person-avatar'
import { SiteFooter } from '../components/site-footer'
import { Swatch } from '../components/swatch'
import { WriterCard } from '../components/writer-card'
import { relativeTime } from '../lib/format'
import { SAMPLE, type SampleActivity } from '../lib/sample-card'
import { blogHost, blogUrl, suggestHandle } from '../lib/suggest-handle'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useSession } from '../session'
import { useNow, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'

/** What tela-api says of a handle (`GET /api/v1/public/handles/:handle`). */
export type Availability = {
  handle: string
  status: 'available' | 'taken' | 'invalid' | 'reserved'
  suggestion: string | null
}

const STATUSES: readonly string[] = ['available', 'taken', 'invalid', 'reserved']

/** An answer as the page reads it, or null for anything else: an unknown, never a verdict. */
export function availabilityOf(body: unknown, handle: string): Availability | null {
  if (typeof body !== 'object' || body === null) return null
  const { status, suggestion } = body as Record<string, unknown>
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null
  return {
    handle,
    status: status as Availability['status'],
    suggestion: typeof suggestion === 'string' && HANDLE.test(suggestion) ? suggestion : null,
  }
}

/** How long typing pauses before the page asks whether a handle is free. */
const SETTLE_MS = 400

/**
 * Whether `handle` is free, once typing has paused. What the rules refuse is said without asking;
 * an answer that fails or never comes says nothing, and never holds the button back.
 */
function useAvailability(handle: string | null): Availability | null {
  const [answer, setAnswer] = useState<Availability | null>(null)
  useEffect(() => {
    if (!handle) return
    if (!HANDLE.test(handle) || RESERVED_HANDLES.has(handle)) {
      setAnswer({
        handle,
        status: HANDLE.test(handle) ? 'reserved' : 'invalid',
        suggestion: null,
      })
      return
    }
    const ask = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/v1/public/handles/${encodeURIComponent(handle)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ask.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: unknown) => {
          const said = availabilityOf(body, handle)
          if (said) setAnswer(said)
        })
        .catch(() => {})
    }, SETTLE_MS)
    return () => {
      clearTimeout(timer)
      ask.abort()
    }
  }, [handle])
  // An answer is shown only for the handle it is about.
  return answer?.handle === handle ? answer : null
}

/** The part of the front page's JSON this page reads: how many blogs are public. */
type FrontCounts = { counts?: { blogs?: unknown } }

const FIELD =
  'h-[50px] w-full rounded-xl border border-thumb bg-field px-[18px] text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink'
const PRIMARY =
  'inline-flex h-12 shrink-0 items-center justify-center rounded-full bg-primary px-[26px] text-[15px] font-semibold whitespace-nowrap text-on-primary hover:text-on-primary hover:no-underline hover:brightness-125 disabled:opacity-60'
const QUIET =
  'inline-flex h-12 shrink-0 items-center justify-center rounded-full border border-thumb px-[22px] text-[15px] font-medium text-ink hover:border-ink hover:text-ink hover:no-underline'
const SECTION = 'border-t border-line py-16 md:py-[88px]'
const H2 =
  'm-0 mb-10 font-serif text-[36px] leading-[1.05] font-medium tracking-[-0.015em] md:mb-12 md:text-[46px]'
const LABEL = 'text-[11px] font-semibold tracking-[0.1em] uppercase'
/** A small card under a point of "What your card does", as the design draws its illustrations. */
const SKETCH = 'mt-2.5 rounded-xl border border-line bg-surface px-[18px] py-1.5'

export function WritersPage() {
  const t = useTranslations('writers')
  useTitle(t('title'))
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  const { locale } = useUi()
  const now = useNow()
  const door = useFrontDoor()
  // As the header decides: a device known to hold no member gets the form at once.
  const visitor = status === 'guest' || (status === 'unknown' && store.userId === null)

  const front = usePublic<FrontCounts>('/api/v1/public/front')
  const counted = front.status === 'ready' ? front.data.counts?.blogs : undefined
  const blogs = typeof counted === 'number' && counted > 0 ? counted : null

  const [name, setName] = useState('')
  const [blog, setBlog] = useState('')
  // A suggestion the visitor took, until they type again.
  const [picked, setPicked] = useState<string | null>(null)
  const handle = picked ?? suggestHandle(name, blog)
  const availability = useAvailability(handle)
  const typed = name.trim() !== '' || blog.trim() !== ''
  const draft = visitor && typed ? { name, handle, host: blogHost(blog) } : null
  const form = useRef<HTMLFormElement>(null)
  const nameField = useRef<HTMLInputElement>(null)

  const claim = (e: React.FormEvent) => {
    e.preventDefault()
    door?.({ mode: 'claim', handle: handle ?? '', name: name.trim(), blog: blogUrl(blog) })
  }
  const toForm = () => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    form.current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' })
    nameField.current?.focus({ preventScroll: true })
  }

  const ownHandle = tables.profile?.handle ?? null
  const { writer } = SAMPLE
  const accent = (chunks: React.ReactNode) => <em className="text-accent italic">{chunks}</em>
  // The sample says it is one wherever it is shown: here, and on the activity card's label.
  const caption = draft
    ? t('card.captionDraft')
    : visitor
      ? t('card.captionSample')
      : t('card.captionSampleMember')

  return (
    <>
      <main
        className="mx-auto w-full max-w-[1200px] flex-1 animate-fade px-4 sm:px-6 md:px-10"
        data-testid="writers-page"
      >
        <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] items-center gap-x-20 gap-y-14 pt-12 pb-20 md:pt-20 md:pb-[104px]">
          <div className="flex min-w-0 flex-col">
            <div className={`${LABEL} text-accent`}>{t('kicker')}</div>
            <h1 className="mt-[18px] mb-[22px] font-serif text-[44px] leading-[1.02] font-medium tracking-[-0.025em] text-balance sm:text-[56px] lg:text-[68px]">
              {t.rich('hero.title', { em: accent })}
            </h1>
            <p className="m-0 max-w-[520px] text-[17px] leading-[1.55] text-pretty text-ink-2 md:text-[18px]">
              {t('hero.lede')}
            </p>
            {visitor ? (
              <form
                ref={form}
                onSubmit={claim}
                className="mt-9 flex max-w-[500px] flex-col gap-2.5"
                data-testid="writers-form"
              >
                <h2 className={`${LABEL} m-0 text-muted`}>{t('form.title')}</h2>
                <input
                  ref={nameField}
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setPicked(null)
                  }}
                  placeholder={t('form.name')}
                  aria-label={t('form.name')}
                  data-testid="writers-name"
                  className={FIELD}
                />
                <label className="flex h-[50px] items-center rounded-xl border border-thumb bg-field px-[18px] text-[15px] focus-within:border-ink">
                  <span className="text-muted" aria-hidden="true">
                    https://
                  </span>
                  <input
                    name="blog"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    autoCapitalize="off"
                    spellCheck={false}
                    required
                    value={blog}
                    onChange={(e) => {
                      setBlog(e.target.value)
                      setPicked(null)
                    }}
                    placeholder={t('form.blogPlaceholder')}
                    aria-label={t('form.blog')}
                    data-testid="writers-blog"
                    className="h-full min-w-0 flex-1 bg-transparent px-1 text-ink outline-none placeholder:text-muted"
                  />
                </label>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                  <p
                    aria-live="polite"
                    className="m-0 min-h-[18px] min-w-0 flex-1 basis-[220px] text-[13px] leading-[18px]"
                    data-testid="writers-availability"
                    data-status={availability?.status ?? (handle ? 'unknown' : 'none')}
                  >
                    {!typed ? null : !handle ? (
                      <span className="text-muted">{t('availability.none')}</span>
                    ) : availability?.status === 'available' ? (
                      <span className="text-accent">{t('availability.available', { handle })}</span>
                    ) : availability ? (
                      <span className="text-ink-2">
                        {t(`availability.${availability.status}`, { handle })}
                        {availability.suggestion ? (
                          <>
                            {' '}
                            {t.rich('availability.try', {
                              suggestion: availability.suggestion,
                              pick: (chunks) => (
                                <button
                                  type="button"
                                  onClick={() => setPicked(availability.suggestion)}
                                  data-testid="writers-suggestion"
                                  className="font-medium text-accent underline underline-offset-2 hover:text-accent-strong"
                                >
                                  {chunks}
                                </button>
                              ),
                            })}
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </p>
                  <button type="submit" className={PRIMARY} data-testid="writers-claim">
                    {t('form.submit')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-9 flex max-w-[500px] flex-col gap-4" data-testid="writers-member">
                <p className="m-0 text-[15px] text-ink-2">{t('member.intro')}</p>
                <div className="flex flex-wrap gap-3">
                  <Link to="/claim" className={PRIMARY} data-testid="writers-claim-blog">
                    {t('member.claim')}
                  </Link>
                  {ownHandle ? (
                    <Link to={`/@${ownHandle}`} className={QUIET} data-testid="writers-your-card">
                      {t('member.card')}
                    </Link>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-3.5">
            <WriterCard draft={draft} sample={SAMPLE} />
            <span className="text-center text-[13px] text-muted" data-testid="writer-card-caption">
              {caption}
            </span>
          </div>
        </section>

        <section
          className={`${SECTION} grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-center gap-x-20 gap-y-12`}
          data-testid="writers-find"
        >
          <div className="flex flex-col gap-[18px]">
            <h2 className="m-0 font-serif text-[38px] leading-[1.04] font-medium tracking-[-0.02em] text-balance md:text-[50px]">
              {t('find.title')}
            </h2>
            <p className="m-0 max-w-[480px] text-[16px] leading-[1.6] text-ink-2 md:text-[17px]">
              {t('find.intro')}
            </p>
          </div>
          <div className="min-w-0 rounded-2xl border border-line bg-surface px-5 py-2 sm:px-6">
            <div className={`${LABEL} pt-4 pb-1 text-muted`}>{t('find.label')}</div>
            <ul className="m-0 list-none p-0">
              {SAMPLE.activity.map((a, i) => (
                <ActivityRow
                  key={`${a.kind}-${a.who.handle}`}
                  item={a}
                  first={i === 0}
                  when={relativeTime(now - a.ago, locale, now)}
                />
              ))}
            </ul>
          </div>
        </section>

        <section className={SECTION}>
          <h2 className={H2}>{t('does.title')}</h2>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-10 gap-y-12 p-0">
            {(['link', 'blogroll', 'readers'] as const).map((k, i) => (
              <li key={k} className="flex min-w-0 flex-col gap-3">
                <span className="font-serif text-[22px] text-accent" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="m-0 font-serif text-[27px] leading-[1.15] font-medium">
                  {t(`does.${k}.title`)}
                </h3>
                <p className="m-0 text-[15px] leading-[1.55] text-ink-2">{t(`does.${k}.body`)}</p>
                {k === 'link' ? (
                  <span
                    className="mt-2.5 flex max-w-full items-center gap-2.5 self-start rounded-full border border-line bg-surface py-2 pr-2 pl-[18px] text-[14px]"
                    data-testid="writers-link-pill"
                  >
                    <span className="text-ink-2">{t('does.link.pill')}</span>
                    <span className="truncate font-semibold text-ink">@{writer.handle}</span>
                    <span
                      aria-hidden="true"
                      className="rounded-full bg-hover px-2.5 py-1 text-[12px] text-ink-2"
                    >
                      ↗
                    </span>
                  </span>
                ) : null}
                {k === 'blogroll' ? (
                  <ul className={`${SKETCH} m-0 list-none`} data-testid="writers-roll">
                    {SAMPLE.roll.map((blog, j) => (
                      <li
                        key={blog.name}
                        className={`flex items-center gap-2.5 py-[11px] ${j ? 'border-t border-line' : ''}`}
                      >
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-[3px]"
                          style={{ background: blog.color }}
                        />
                        <span className="min-w-0 flex-1 truncate font-serif text-[17px]">
                          {blog.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {k === 'readers' ? (
                  <ul className={`${SKETCH} m-0 list-none`} data-testid="writers-readers">
                    <li className="flex items-center gap-2.5 py-[11px]">
                      <Swatch id={0} color={SAMPLE.blog.color} title={SAMPLE.blog.name} size={28} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[14px] font-medium">{SAMPLE.blog.name}</span>
                        <span className="text-[12.5px] text-muted">
                          {t('does.readers.blogReaders', { n: SAMPLE.blogReaders })}
                        </span>
                      </span>
                    </li>
                    <li className="flex items-center gap-2.5 border-t border-line py-[11px]">
                      <PersonAvatar handle={writer.handle} displayName={writer.name} size={28} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[14px] font-medium">{writer.name}</span>
                        <span className="text-[12.5px] text-muted">
                          {t('does.readers.followers', { n: SAMPLE.counts.followers })}
                        </span>
                      </span>
                    </li>
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        <section className={SECTION}>
          <h2 className={H2}>{t('how.title')}</h2>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-10 p-0">
            {(['name', 'connect', 'follow'] as const).map((k, i) => (
              <li key={k} className="flex flex-col gap-2.5 border-t-2 border-ink pt-5">
                <span
                  aria-hidden="true"
                  className="font-serif text-[56px] leading-[0.9] text-accent"
                >
                  {i + 1}
                </span>
                <h3 className="m-0 mt-2 text-[17px] font-semibold">{t(`how.${k}.title`)}</h3>
                <p className="m-0 text-[15px] leading-[1.55] text-ink-2">{t(`how.${k}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid items-start gap-x-12 gap-y-8 border-t border-line py-14 sm:grid-cols-2 md:py-[72px] lg:grid-cols-4">
          <h2 className="m-0 font-serif text-[30px] leading-[1.1] font-medium tracking-[-0.01em] md:text-[34px]">
            {t('yours.title')}
          </h2>
          {(['nothing', 'ads', 'translation'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <h3 className="m-0 text-[15.5px] font-semibold">{t(`yours.${k}.title`)}</h3>
              <p className="m-0 text-[14.5px] leading-normal text-ink-2">{t(`yours.${k}.body`)}</p>
            </div>
          ))}
        </section>

        <section className="flex flex-col items-center gap-7 border-t border-line pt-20 pb-24 text-center md:pt-24 md:pb-28">
          <h2
            className="m-0 max-w-[780px] font-serif text-[40px] leading-[1.04] font-medium tracking-[-0.02em] text-balance md:text-[58px]"
            data-testid="writers-cta-title"
          >
            {blogs !== null
              ? t.rich('cta.count', { n: blogs, em: accent })
              : t.rich('cta.title', { em: accent })}
          </h2>
          {visitor ? (
            <button
              type="button"
              onClick={toForm}
              className={`${PRIMARY} h-[52px] px-[30px]`}
              data-testid="writers-make"
            >
              {t('cta.make')}
            </button>
          ) : (
            <Link to="/claim" className={`${PRIMARY} h-[52px] px-[30px]`}>
              {t('member.claim')}
            </Link>
          )}
        </section>
      </main>
      <SiteFooter year={new Date(now).getFullYear()} />
    </>
  )
}

/**
 * One row of the sample's Following page, as the page draws the real one: who, what, when, then
 * the post or the blog, and the note a recommendation carried. Text only: the sample's posts are
 * no one's, so nothing here links.
 */
function ActivityRow({
  item,
  first,
  when,
}: {
  item: SampleActivity
  first: boolean
  when: string
}) {
  const t = useTranslations('writers')
  const { who } = item
  return (
    <li
      className={`grid grid-cols-[34px_minmax(0,1fr)] gap-3 py-4 ${first ? '' : 'border-t border-line'}`}
      data-testid="writers-activity"
      data-kind={item.kind}
    >
      <PersonAvatar handle={who.handle} displayName={who.name} size={34} />
      <div className="flex min-w-0 flex-col gap-[5px]">
        <div className="text-[13.5px] leading-[1.45] text-ink-2">
          <b className="font-semibold text-ink">{who.name}</b>
          <span className="text-muted"> {item.writes.name}</span>
          {' · '}
          {t(`find.${item.kind}`, { source: item.blog.name })}
          <span className="text-muted"> · {when}</span>
        </div>
        <span className="font-serif text-[19px] leading-[1.25] font-medium text-ink">
          {item.post ? t(`sample.posts.${item.post}`) : item.blog.name}
        </span>
        {item.note ? (
          <p
            className="m-0 border-l-2 border-accent pl-3 font-serif text-[16.5px] leading-[1.4] text-ink-2 italic"
            data-testid="writers-note"
          >
            “{item.note}”
          </p>
        ) : null}
      </div>
    </li>
  )
}
