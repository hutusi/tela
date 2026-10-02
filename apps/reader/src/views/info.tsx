/**
 * About, Privacy and Terms (`/about`, `/privacy`, `/terms`): the copy of `content/info` in the UI's
 * language. Rendered by the SPA and by the edge, which needs no data for them (ADR 0035).
 */
import type { UiLocale } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { en } from '../content/info/en'
import {
  type Block,
  INFO_PAGES,
  INFO_SECTIONS,
  INFO_UPDATED,
  type InfoContent,
  type InfoPageId,
  type Section,
} from '../content/info/types'
import { zhHans } from '../content/info/zh-Hans'
import { Inline, plainText } from '../lib/inline-links'

const CONTENT: Record<UiLocale, InfoContent> = { en, 'zh-Hans': zhHans }

export function infoContent(locale: UiLocale): InfoContent {
  return CONTENT[locale] ?? en
}

/** What a link preview says about a page: its lede, or else its short version. */
export function infoDescription(locale: UiLocale, page: InfoPageId): string {
  const content = infoContent(locale)[page]
  return plainText('lede' in content && content.lede ? content.lede : content.short.join(' '))
}

/** "2 October 2026", "2026年10月2日": the day itself, wherever the page is rendered. */
function updatedOn(locale: UiLocale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${INFO_UPDATED}T00:00:00Z`))
}

const tab = (on: boolean) =>
  `rounded-full border px-3.5 py-1.5 text-[13px] hover:no-underline ${
    on ? 'border-ink bg-ink text-paper' : 'border-line text-ink-2 hover:border-ink'
  }`

function BlockView({ block }: { block: Block }) {
  if ('p' in block)
    return (
      <p className="my-3 leading-relaxed text-body">
        <Inline text={block.p} />
      </p>
    )
  if ('h' in block)
    return <h3 className="mb-1 mt-6 text-[15px] font-semibold text-ink">{block.h}</h3>
  if ('list' in block)
    return (
      <ul className="my-3 flex list-disc flex-col gap-2 pl-5 leading-relaxed text-body marker:text-muted">
        {block.list.map((item) => (
          <li key={item}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    )
  return (
    <div className="my-4 flex flex-col gap-4">
      {block.entries.map((entry, i) => (
        <div key={entry.name} className="flex gap-4">
          {block.numbered ? (
            <span className="w-6 shrink-0 pt-0.5 font-serif text-[15px] tabular-nums text-muted">
              {String(i + 1).padStart(2, '0')}
            </span>
          ) : null}
          <div className="min-w-0">
            <p className="m-0 font-semibold text-ink">
              <Inline text={entry.name} />
            </p>
            <p className="m-0 mt-0.5 leading-relaxed text-body">
              <Inline text={entry.text} />
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

export function InfoView({ page, locale }: { page: InfoPageId; locale: UiLocale }) {
  const t = useTranslations('info')
  const content = infoContent(locale)[page]
  const ids = INFO_SECTIONS[page]
  const sections = content.sections as Record<string, Section>
  return (
    <main
      className="mx-auto w-full max-w-[1040px] flex-1 px-4 pb-20 pt-10 animate-fade md:px-12"
      data-testid="info-page"
      data-page={page}
    >
      <nav aria-label={t('pages')} className="mb-9 flex flex-wrap gap-2" data-testid="info-tabs">
        {INFO_PAGES.map((p) => (
          <Link
            key={p}
            to={`/${p}`}
            className={tab(p === page)}
            aria-current={p === page ? 'page' : undefined}
          >
            {t(`tabs.${p}`)}
          </Link>
        ))}
      </nav>

      <header className="mb-10 max-w-[680px]">
        {'kicker' in content && content.kicker ? (
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            {content.kicker}
          </p>
        ) : null}
        <h1 className="mb-3 font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
          {content.title}
        </h1>
        {'lede' in content && content.lede ? (
          <p className="mb-3 text-[17px] leading-relaxed text-ink-2">
            <Inline text={content.lede} />
          </p>
        ) : null}
        <p className="m-0 text-[13px] text-muted" data-testid="info-updated">
          {t('updated', { date: updatedOn(locale) })}
        </p>
      </header>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
        <nav
          aria-labelledby="info-toc-title"
          className="mb-10 lg:sticky lg:top-20 lg:self-start"
          data-testid="info-toc"
        >
          <p
            id="info-toc-title"
            className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted"
          >
            {t('onThisPage')}
          </p>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {ids.map((id) => (
              <li key={id}>
                <a href={`#${id}`} className="text-ink-2 hover:text-ink">
                  {sections[id]?.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="max-w-[680px] text-[15px]">
          <section
            aria-labelledby="info-short-title"
            className="mb-10 rounded-xl border border-line bg-surface px-5 py-4"
            data-testid="info-short"
          >
            <h2 id="info-short-title" className="mb-2 text-[15px] font-semibold text-ink">
              {t('short')}
            </h2>
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-body marker:text-muted">
              {content.short.map((line) => (
                <li key={line}>
                  <Inline text={line} />
                </li>
              ))}
            </ul>
          </section>

          {ids.map((id) => {
            const section = sections[id]
            if (!section) return null
            return (
              <section key={id} id={id} className="mb-10 scroll-mt-20">
                <h2 className="mb-2 font-serif text-[26px] font-medium leading-tight tracking-tight">
                  {section.heading}
                </h2>
                {section.blocks.map((block, i) => (
                  // Blocks never move: the copy is fixed, so their place is who they are.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static copy, never reordered
                  <BlockView key={i} block={block} />
                ))}
              </section>
            )
          })}
        </div>
      </div>
    </main>
  )
}
