/**
 * `/writers` (For writers): a writer's calling card, made as they type. The example beside the
 * form is a real member's live public card (`lib/example.ts`), and every line of the page says
 * only what Tela does today. "Claim your card" opens the sheet in claim mode, which makes the card
 * on the way in and goes on to claim the blog (`lib/claim-card.ts`). A member gets the ways on to
 * their card and their blog instead. SPA-only, and noindex with the rest of the beta (ADR 0035).
 */
import { HANDLE, RESERVED_HANDLES } from '@tela/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useFrontDoor } from '../components/front-door'
import { PersonAvatar } from '../components/person-avatar'
import { WriterCard } from '../components/writer-card'
import { EXAMPLE_HANDLE } from '../lib/example'
import { displayHost, swatchColor } from '../lib/format'
import { useMemberControls } from '../lib/member'
import { readingPrefsOf } from '../lib/prefs'
import { publicTitle } from '../lib/public-title'
import { blogHost, blogUrl, suggestHandle } from '../lib/suggest-handle'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useSession } from '../session'
import { useReadingLang, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { PostLink } from '../views/post-link'
import { profileDataOf } from '../views/public-data'
import type { ProfileData, Reading } from '../views/types'
import { profilePath } from './profile'

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
  'h-11 w-full rounded-[10px] border border-thumb bg-surface px-3.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink'
const PRIMARY =
  'inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-[15px] font-medium text-on-primary hover:no-underline hover:brightness-125 disabled:opacity-60'
const QUIET =
  'inline-flex h-11 items-center justify-center rounded-full border border-thumb bg-surface px-5 text-[15px] font-medium text-ink hover:border-ink hover:no-underline'
const SECTION = 'mx-auto w-full max-w-[1120px] px-4 py-16 md:px-12 md:py-20'
const H2 = 'm-0 font-serif text-[32px] leading-[1.1] font-medium tracking-[-0.015em] md:text-[40px]'

export function WritersPage() {
  const t = useTranslations('writers')
  useTitle(t('title'))
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const never = readingPrefsOf(tables).never
  const reading = useMemo(() => ({ lang: readingLang, never }), [readingLang, never])
  const member = useMemberControls()
  const door = useFrontDoor()
  // As the header decides: a device known to hold no member gets the form at once.
  const visitor = status === 'guest' || (status === 'unknown' && store.userId === null)

  const loaded = usePublic<ProfileData>(profilePath(EXAMPLE_HANDLE))
  const example = loaded.status === 'ready' ? profileDataOf(loaded.data) : null
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
  const draft = typed ? { name, handle, host: blogHost(blog) } : null
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
  const notes = (example?.recommendations ?? []).filter((r) => r.note).slice(0, 3)

  return (
    <main className="flex-1 animate-fade" data-testid="writers-page">
      <section className="mx-auto grid w-full max-w-[1120px] items-start gap-12 px-4 pt-12 pb-16 md:px-12 md:pt-20 md:pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-16">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold tracking-[0.08em] text-accent uppercase">
            {t('kicker')}
          </div>
          <h1 className="mt-4 mb-0 font-serif text-[42px] leading-[1.04] font-medium tracking-[-0.02em] md:text-[58px]">
            {t.rich('hero.title', {
              em: (chunks) => <em className="text-accent italic">{chunks}</em>,
            })}
          </h1>
          <p className="mt-5 mb-0 max-w-[540px] text-[17px] leading-[1.55] text-ink-2">
            {t('hero.lede')}
          </p>
          {visitor ? (
            <form
              ref={form}
              onSubmit={claim}
              className="mt-9 flex max-w-[460px] flex-col gap-3"
              data-testid="writers-form"
            >
              <h2 className="m-0 text-[14px] font-semibold text-ink">{t('form.title')}</h2>
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
              <label className="flex h-11 items-center rounded-[10px] border border-thumb bg-surface text-[15px] focus-within:border-ink">
                <span className="pl-3.5 text-muted" aria-hidden="true">
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
                  className="h-full min-w-0 flex-1 bg-transparent pr-3.5 pl-0.5 text-ink outline-none placeholder:text-muted"
                />
              </label>
              <p
                aria-live="polite"
                className="m-0 min-h-5 text-[13.5px] leading-5"
                data-testid="writers-availability"
                data-status={availability?.status ?? (handle ? 'unknown' : 'none')}
              >
                {!typed ? null : !handle ? (
                  <span className="text-muted">{t('availability.none')}</span>
                ) : availability?.status === 'available' ? (
                  <span className="font-medium text-accent">
                    {t('availability.available', { handle })}
                  </span>
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
              <p className="m-0 text-[12.5px] text-muted">{t('form.hint')}</p>
            </form>
          ) : (
            <div className="mt-9 flex flex-col gap-4" data-testid="writers-member">
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
        <div className="min-w-0 lg:sticky lg:top-24">
          <WriterCard draft={visitor ? draft : null} example={example} reading={reading} />
        </div>
      </section>

      {example && notes.length > 0 ? (
        <section className="border-t border-line" data-testid="writers-find">
          <div className={SECTION}>
            <h2 className={H2}>{t('find.title')}</h2>
            <p className="mt-3 mb-0 max-w-[600px] text-[15.5px] leading-relaxed text-ink-2">
              {t('find.intro', {
                name: example.profile.displayName ?? `@${example.profile.handle}`,
              })}
            </p>
            <ul className="m-0 mt-10 grid list-none gap-5 p-0 md:grid-cols-3">
              {notes.map((r) => (
                <Recommendation
                  key={r.article.id}
                  item={r}
                  person={example.profile}
                  member={member}
                  reading={reading}
                />
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="border-t border-line">
        <div className={SECTION}>
          <h2 className={H2}>{t('does.title')}</h2>
          <ol className="m-0 mt-10 grid list-none gap-8 p-0 md:grid-cols-3 md:gap-10">
            {(['link', 'blogroll', 'readers'] as const).map((k, i) => (
              <li key={k} className="flex flex-col gap-2 border-t border-ink pt-4">
                <span className="font-serif text-[15px] text-muted" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="m-0 font-serif text-[22px] leading-[1.2] font-medium">
                  {t(`does.${k}.title`)}
                </h3>
                <p className="m-0 text-[14.5px] leading-relaxed text-ink-2">
                  {t(`does.${k}.body`)}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-line">
        <div className={SECTION}>
          <h2 className={H2}>{t('how.title')}</h2>
          <ol className="m-0 mt-10 grid list-none gap-8 p-0 md:grid-cols-3 md:gap-10">
            {(['name', 'connect', 'follow'] as const).map((k, i) => (
              <li key={k} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full border border-thumb font-serif text-[17px] font-medium"
                >
                  {i + 1}
                </span>
                <div className="flex flex-col gap-1.5">
                  <h3 className="m-0 font-serif text-[21px] leading-[1.2] font-medium">
                    {t(`how.${k}.title`)}
                  </h3>
                  <p className="m-0 text-[14.5px] leading-relaxed text-ink-2">
                    {t(`how.${k}.body`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-line bg-hover">
        <div className={SECTION}>
          <h2 className={H2}>{t('yours.title')}</h2>
          <ul className="m-0 mt-10 grid list-none gap-8 p-0 md:grid-cols-3 md:gap-10">
            {(['nothing', 'ads', 'translation'] as const).map((k) => (
              <li key={k} className="flex flex-col gap-2">
                <h3 className="m-0 font-serif text-[21px] leading-[1.2] font-medium">
                  {t(`yours.${k}.title`)}
                </h3>
                <p className="m-0 text-[14.5px] leading-relaxed text-ink-2">
                  {t(`yours.${k}.body`)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col items-start gap-6 px-4 py-16 md:flex-row md:items-center md:justify-between md:px-12 md:py-20">
          <h2 className={`${H2} max-w-[640px]`} data-testid="writers-cta-title">
            {blogs !== null ? t('cta.count', { n: blogs }) : t('cta.title')}
          </h2>
          {visitor ? (
            <button
              type="button"
              onClick={toForm}
              className={`${PRIMARY} shrink-0`}
              data-testid="writers-make"
            >
              {t('cta.make')}
            </button>
          ) : (
            <Link to="/claim" className={`${PRIMARY} shrink-0`}>
              {t('member.claim')}
            </Link>
          )}
        </div>
      </section>
    </main>
  )
}

/** One of the example's recommendations with a note: the note, the post, and who said it. */
function Recommendation({
  item,
  person,
  member,
  reading,
}: {
  item: ProfileData['recommendations'][number]
  person: ProfileData['profile']
  member: ReturnType<typeof useMemberControls>
  reading: Reading
}) {
  const source = item.siteTitle ?? displayHost(item.homeUrl)
  const { title, badge } = publicTitle(item.article, reading)
  return (
    <li
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5"
      data-testid="writers-note"
    >
      <p className="m-0 font-serif text-[19px] leading-[1.4] italic" style={{ textWrap: 'pretty' }}>
        “{item.note}”
      </p>
      <div className="relative mt-auto flex flex-col gap-1.5 hover:opacity-75">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ background: swatchColor(item.article.feedId) }}
          />
          <span className="truncate font-medium text-ink">{source}</span>
          {badge ? (
            <span className="rounded border border-line px-[5px] text-[10.5px]">{badge}</span>
          ) : null}
        </div>
        <h3 className="m-0 font-serif text-[18px] leading-[1.25] font-medium">
          <PostLink
            article={item.article}
            source={source}
            member={member}
            className="text-ink after:absolute after:inset-0 hover:no-underline"
          >
            {title}
          </PostLink>
        </h3>
      </div>
      <Link
        to={`/@${person.handle}`}
        className="flex items-center gap-2 border-t border-line pt-3 text-[12.5px] text-ink-2 hover:text-ink hover:no-underline"
      >
        <PersonAvatar
          handle={person.handle}
          displayName={person.displayName}
          avatar={person.avatar}
          size={22}
        />
        <span className="truncate">
          <b className="font-medium text-ink">{person.displayName ?? `@${person.handle}`}</b> · @
          {person.handle}
        </span>
      </Link>
    </li>
  )
}
