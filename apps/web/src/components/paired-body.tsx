'use client'

import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { useLocale, useTranslations } from 'next-intl'
import { Fragment } from 'react'
import type { BlockPair } from '@/lib/block-pairs'

/** Headings carry their own lead, which `.article-block` zeroes; the row puts it back. */
const LEAD = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

type Props = {
  pairs: BlockPair[]
  title: string
  originalTitle: string
  targetLang: string
  sourceLang: string | undefined
}

/**
 * The translation and its original, one grid row per top-level block.
 *
 * Every cell is a direct child of one grid, in `t1, o1, t2, o2 …` order. Two columns place pair
 * *i* on row *i*, so the two sides align by construction and cannot drift apart the way two
 * whole documents in two cells did. One column reads the same DOM as an interleave — the
 * translation, then its own original, then the next paragraph — which keeps the full measure
 * instead of halving it.
 *
 * That DOM order is why there are no per-side wrappers here. A wrapper per language (even
 * `display: contents`, even `grid-template-rows: subgrid`) would put every translation before
 * every original, which is the layout this replaced.
 */
export function PairedBody({ pairs, title, originalTitle, targetLang, sourceLang }: Props) {
  const tt = useTranslations('translation')
  const locale = useLocale()
  const targetName =
    (LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en)[targetLang] ?? targetLang

  return (
    <div className="@container">
      <div
        className="grid grid-cols-[minmax(0,640px)] items-start gap-x-10 @min-[1080px]:grid-cols-[minmax(0,640px)_minmax(0,640px)]"
        data-testid="paired-body"
      >
        {/* `hidden` rather than `sr-only`: display:none takes the cell out of the grid, and
            `not-sr-only` would set margin:0 against mb-3.5 with no defined winner. */}
        <div className="mb-3.5 hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-accent @min-[1080px]:block">
          {tt('columnTranslated', { target: targetName })}
        </div>
        <div className="mb-3.5 hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-muted @min-[1080px]:block">
          {tt('columnOriginal')}
        </div>

        <h1
          className="mb-6 font-serif text-[32px] font-medium leading-[1.12] tracking-tight"
          style={{ textWrap: 'pretty' }}
          lang={targetLang}
          data-testid="article-title"
        >
          {title}
        </h1>
        {/* The title sits on the source ground too, so the second column reads as one surface
            from its heading down rather than as a title above an unrelated band. */}
        <h1
          className="article-source mb-6 font-serif text-[32px] font-medium leading-[1.12] tracking-tight text-ink-2"
          style={{ textWrap: 'pretty' }}
          lang={sourceLang}
          dir="auto"
          data-edge-first=""
          data-testid="article-title-original"
        >
          {originalTitle}
        </h1>

        {pairs.map((pair, i) => {
          const cell = `min-w-0 article-body${pair.tag === null ? '' : ' article-block'}${
            pair.tag !== null && LEAD.has(pair.tag) ? ' mt-3' : ''
          }`
          // A block whose translation failed is showing its source text. Say so, in a real
          // element rather than generated content: ::before is unselectable and only most
          // screen readers announce it. Only the failures pay for the wrapper.
          const translatedCell = (
            <div
              className={cell}
              lang={pair.untranslated ? sourceLang : targetLang}
              data-testid="body-translated"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; images go through the signed proxy
              dangerouslySetInnerHTML={{ __html: pair.translated }}
            />
          )
          return (
            <Fragment key={pair.id}>
              {pair.untranslated ? (
                <div className="article-untranslated min-w-0">
                  <span className="article-untranslated-label">{tt('blockUntranslated')}</span>
                  {translatedCell}
                </div>
              ) : (
                translatedCell
              )}
              <div
                className={`${cell} article-source`}
                lang={sourceLang}
                dir="auto"
                data-testid="body-original"
                // Two columns tile the source cells into one continuous band; only its two ends
                // need the padding and the rounding that every stacked panel gets, and the top
                // end is the title above.
                data-edge-last={i === pairs.length - 1 ? '' : undefined}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; images go through the signed proxy
                dangerouslySetInnerHTML={{ __html: pair.original }}
              />
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
