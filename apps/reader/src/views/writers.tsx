/**
 * For writers (`/writers`): a writer's calling card, made as they type. Beside the form is a
 * sample card, labelled as one (`lib/sample-card.ts`, ADR 0037), and the Following page under it
 * draws from the same sample; every line of the page says only what Tela does today. "Claim your
 * card" opens the sheet in claim mode, which makes the card on the way in and goes on to claim the
 * blog (`lib/claim-card.ts`). A member gets the ways on to their card and their blog instead.
 *
 * Then, in one column (Tela Public, ADR 0070), what the card does, how it works, how a claim is
 * proved and how a writer keeps Tela out (ADR 0061), each under an anchor the Dashboard and the
 * info pages link to; how Tela reads a blog is its own page, `/bot`. Rendered by the SPA and by
 * the edge, which needs no data for it: it renders for a visitor, without the count of blogs,
 * which the app fetches once it takes the page over.
 */
import { HANDLE, RESERVED_HANDLES, type UiLocale } from '@tela/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useFrontDoor } from '../components/front-door'
import { CHECK, Glyph } from '../components/glyph'
import { PersonAvatar } from '../components/person-avatar'
import { SiteFooter } from '../components/site-footer'
import { WriterCard } from '../components/writer-card'
import { relativeTime } from '../lib/format'
import { scrollMotion } from '../lib/motion'
import { SAMPLE, type SampleActivity } from '../lib/sample-card'
import { blogHost, blogUrl, suggestHandle } from '../lib/suggest-handle'
import { DOC_COLUMN, DocItem, DocItems, DocSection, useDocText } from './doc'
import {
  BODY,
  HEAD,
  INTRO,
  META,
  PAGE,
  PILL,
  PILL_QUIET,
  PRE,
  STANDFIRST,
  TEXT_LINK,
  TITLE,
} from './public-type'

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

const FIELD =
  'h-[46px] w-full rounded-[10px] border border-thumb bg-field px-3.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink'
/** A section's head beside its illustration, and the closing call's. */
const SIDE_HEAD = `${HEAD} leading-[1.25] [font-size:calc(clamp(24px,3vw,30px)*var(--hs))]`
/** The hero's two columns and the Following page's: words on the left, the picture on the right. */
const PAIR = 'flex flex-wrap items-start gap-x-[clamp(40px,6vw,80px)]'
const WORDS = 'min-w-0 max-w-[560px]'
const PICTURE = 'flex min-w-0 max-w-[480px] flex-col gap-2.5'

/** What a writer adds to robots.txt to keep Tela off every page (ADR 0061). */
const ROBOTS_SNIPPET = 'User-agent: Tela\nDisallow: /'

export type WritersViewProps = {
  /** No member here: the form. A member gets the ways on to their card and blog instead. */
  visitor: boolean
  /** The member's own handle, for a link to their card. */
  ownHandle: string | null
  /** How many blogs are public, once known. */
  blogs: number | null
  locale: UiLocale
  now: number
}

export function WritersView({ visitor, ownHandle, blogs, locale, now }: WritersViewProps) {
  const t = useTranslations('writers')
  const text = useDocText()
  const door = useFrontDoor()

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
    form.current?.scrollIntoView({ behavior: scrollMotion(), block: 'center' })
    nameField.current?.focus({ preventScroll: true })
  }

  // The sample says it is one wherever it is shown: here, and on the activity card's label.
  const caption = draft
    ? t('card.captionDraft')
    : visitor
      ? t('card.captionSample')
      : t('card.captionSampleMember')
  const point = (section: string, key: string) => (
    <DocItem key={key} id={`${section}-${key}`} title={t(`${section}.${key}.title`)}>
      {text(`${section}.${key}.body`)}
    </DocItem>
  )

  return (
    <>
      {/* No slanted Chinese: a name or a title in a script with no italic face stays upright. */}
      <main
        className={`${PAGE} animate-fade pt-[clamp(32px,5.6vw,64px)] pb-[clamp(72px,10vw,120px)] [font-synthesis-style:none]`}
        data-testid="writers-page"
      >
        <section className={`${PAIR} gap-y-10`}>
          <div className={`${WORDS} flex-[1_1_420px]`}>
            <p className={`m-0 ${META}`}>{t('kicker')}</p>
            <h1 className={`${TITLE} mt-3 [font-size:calc(clamp(42px,6vw,64px)*var(--hs))]`}>
              {t('hero.title')}
            </h1>
            <p
              className={`${STANDFIRST} mt-4 text-body [font-size:calc(clamp(18.5px,2vw,21px)*var(--bs))]`}
            >
              {t('hero.lede')}
            </p>
            {visitor ? (
              <form
                ref={form}
                onSubmit={claim}
                className="mt-8 border-t border-ink pt-3.5"
                data-testid="writers-form"
              >
                <h2 className={`${HEAD} leading-[1.3] [font-size:calc(24px*var(--hs))]`}>
                  {t('form.title')}
                </h2>
                <div className="mt-4 flex flex-col gap-2.5">
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
                  <label className="flex h-[46px] items-center rounded-[10px] border border-thumb bg-field px-3.5 text-[15px] focus-within:border-ink">
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
                      className="h-full min-w-0 flex-1 bg-transparent px-0.5 text-ink outline-none placeholder:text-muted"
                    />
                  </label>
                  <p
                    aria-live="polite"
                    className="m-0 min-h-5 text-[14px] leading-[1.45] text-ink-2"
                    data-testid="writers-availability"
                    data-status={availability?.status ?? (handle ? 'unknown' : 'none')}
                  >
                    {!typed ? null : !handle ? (
                      <span className="text-muted">{t('availability.none')}</span>
                    ) : availability?.status === 'available' ? (
                      <span className="inline-flex items-center gap-1">
                        <Glyph size={12} className="block shrink-0">
                          {CHECK}
                        </Glyph>
                        {t('availability.available', { handle })}
                      </span>
                    ) : availability ? (
                      <span>
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
                                  className="font-medium text-ink underline decoration-underline underline-offset-[3px] hover:decoration-current"
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
                  <div>
                    <button type="submit" className={PILL} data-testid="writers-claim">
                      {t('form.submit')}
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="mt-8 border-t border-ink pt-3.5" data-testid="writers-member">
                <p className={`${BODY} text-ink-2`}>{t('member.intro')}</p>
                <div className="mt-4 flex flex-wrap gap-2.5">
                  <Link to="/claim" className={PILL} data-testid="writers-claim-blog">
                    {t('member.claim')}
                  </Link>
                  {ownHandle ? (
                    <Link
                      to={`/@${ownHandle}`}
                      className={PILL_QUIET}
                      data-testid="writers-your-card"
                    >
                      {t('member.card')}
                    </Link>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div className={`${PICTURE} flex-[1_1_380px]`}>
            <span className={META} data-testid="writer-card-caption">
              {caption}
            </span>
            <WriterCard draft={draft} sample={SAMPLE} />
          </div>
        </section>

        <section
          className={`${PAIR} mt-[clamp(56px,7vw,80px)] gap-y-7 border-t border-line pt-3.5`}
          data-testid="writers-find"
        >
          <div className={`${WORDS} flex-[1_1_360px]`}>
            <h2 className={SIDE_HEAD}>{t('find.title')}</h2>
            <p className={INTRO}>{t('find.intro')}</p>
          </div>
          <div className={`${PICTURE} flex-[1_1_380px]`}>
            <span className={META}>{t('find.label')}</span>
            <ul className="m-0 list-none rounded-[14px] border border-line bg-surface px-[22px] py-1.5">
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

        <div className={DOC_COLUMN}>
          <DocSection id="does" title={t('does.title')}>
            <DocItems>
              {(['link', 'blogroll', 'readers'] as const).map((k) => point('does', k))}
            </DocItems>
          </DocSection>
          <DocSection id="how" title={t('how.title')}>
            <DocItems numbered>
              {(['name', 'connect', 'follow'] as const).map((k, i) => (
                <DocItem key={k} id={`how-${k}`} n={i + 1} title={t(`how.${k}.title`)}>
                  <p className={BODY}>{t(`how.${k}.body`)}</p>
                </DocItem>
              ))}
            </DocItems>
          </DocSection>
          <DocSection
            id="claiming"
            title={t('claiming.title')}
            intro={text('claiming.intro', INTRO)}
          >
            <DocItems>
              {(['link', 'meta', 'github'] as const).map((k) => point('claiming', k))}
            </DocItems>
            {text('claiming.gives', `${BODY} mt-5`)}
          </DocSection>
          <DocSection id="opt-out" title={t('optOut.title')} intro={text('optOut.intro', INTRO)}>
            <DocItems>
              {(['translation', 'feedOnly', 'robots', 'email'] as const).map((k) => (
                <DocItem key={k} id={`opt-out-${k}`} title={t(`optOut.${k}.title`)}>
                  {text(`optOut.${k}.body`)}
                  {k === 'robots' ? (
                    <pre className={PRE} data-testid="writers-robots-snippet">
                      {ROBOTS_SNIPPET}
                    </pre>
                  ) : null}
                </DocItem>
              ))}
            </DocItems>
          </DocSection>
          <div className="mt-10 border-t border-line pt-[18px]">
            <Link to="/bot" className={`${TEXT_LINK} text-[15px]`} data-testid="writers-to-bot">
              {t('reading.title')}
              <span aria-hidden="true"> →</span>
            </Link>
          </div>
        </div>

        <section className="mt-[clamp(56px,7vw,88px)] flex flex-col items-start gap-[22px] border-t border-ink pt-7">
          <h2
            className={`${HEAD} max-w-[24em] leading-[1.25] [font-size:calc(clamp(26px,3.4vw,34px)*var(--hs))]`}
            data-testid="writers-cta-title"
          >
            {blogs !== null ? t('cta.count', { n: blogs }) : t('cta.title')}
          </h2>
          {visitor ? (
            <button type="button" onClick={toForm} className={PILL} data-testid="writers-make">
              {t('cta.make')}
            </button>
          ) : (
            <Link to="/claim" className={PILL}>
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
 * One row of the sample's Following page, as the page draws the real one: who did what, when,
 * then the post or the blog, and the note a recommendation carried, upright. Text only: the
 * sample's posts are no one's, so nothing here links.
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
  const tc = useTranslations('common')
  const { who } = item
  return (
    <li
      className={`grid grid-cols-[32px_minmax(0,1fr)] gap-3 py-4 ${first ? '' : 'border-t border-line-soft'}`}
      data-testid="writers-activity"
      data-kind={item.kind}
    >
      <PersonAvatar handle={who.handle} displayName={who.name} size={32} />
      <div className="flex min-w-0 flex-col gap-[5px]">
        <div className="text-[13.5px] leading-[1.45] text-ink-2 [overflow-wrap:anywhere]">
          <b className="font-medium text-ink">{who.name}</b>{' '}
          {t(`find.${item.kind}`, { source: item.blog.name })}{' '}
          <span className="whitespace-nowrap text-muted">·&nbsp;{when}</span>
        </div>
        <span className="font-serif leading-(--lh-h) text-ink [font-size:calc(19px*var(--ts))] [font-weight:var(--hw)]">
          {item.post ? t(`sample.posts.${item.post}`) : item.blog.name}
        </span>
        {item.note ? (
          <p
            className="m-0 font-serif leading-(--lh-h) text-body [font-size:calc(16.5px*var(--ts))]"
            data-testid="writers-note"
          >
            {tc('quoted', { text: item.note })}
          </p>
        ) : null}
      </div>
    </li>
  )
}
