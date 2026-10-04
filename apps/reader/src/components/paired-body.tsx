import { asLabel, LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { Fragment } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import type { BlockPair } from '../lib/block-pairs'
import { Untranslated } from './untranslated'

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
 * An article beside its translation, one grid row per top-level block.
 *
 * Every cell is a direct child of one grid, in `o1, t1, o2, t2 …` order. Two columns place pair
 * *i* on row *i*, so the two sides align by construction and cannot drift apart the way two
 * whole documents in two cells did. One column reads the same DOM as an interleave — the source
 * paragraph, then its translation, then the next one — at the member's measure, as a single column
 * would be, instead of halving it. Two columns keep their own 640px measure.
 *
 * The original leads in both, which is the arrangement every facing-page edition uses and the
 * only one where nothing changes places as the window crosses the two-column threshold.
 *
 * That DOM order is why there are no per-side wrappers here. A wrapper per language (even
 * `display: contents`, even `grid-template-rows: subgrid`) would put every translation before
 * every original, which is the layout this replaced.
 */
export function PairedBody({ pairs, title, originalTitle, targetLang, sourceLang }: Props) {
  const tt = useTranslations('translation')
  const locale = useLocale()
  // It starts the column's label ("Anglais · traduction"), though French writes "anglais".
  const targetName = asLabel(
    (LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en)[targetLang] ?? targetLang,
    locale,
  )

  return (
    <div className="@container">
      <div
        className="grid grid-cols-[minmax(0,var(--reader-measure))] items-start gap-x-10 @min-[1040px]:grid-cols-[minmax(0,640px)_minmax(0,640px)]"
        data-testid="paired-body"
      >
        {/* `hidden` rather than `sr-only`: display:none takes the cell out of the grid, and
            `not-sr-only` would set margin:0 against mb-3.5 with no defined winner. */}
        <div className="mb-3.5 hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-muted @min-[1040px]:block">
          {tt('columnOriginal')}
        </div>
        {/* The accent marks the translation wherever it sits, not whichever column is first. */}
        <div className="mb-3.5 hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-accent @min-[1040px]:block">
          {tt('columnTranslated', { target: targetName })}
        </div>

        {/* The title sits on the source ground too, so that column reads as one surface from
            its heading down rather than as a title above an unrelated band. */}
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
        <h1
          className="mb-6 font-serif text-[32px] font-medium leading-[1.12] tracking-tight"
          style={{ textWrap: 'pretty' }}
          lang={targetLang}
          data-testid="article-title"
        >
          {title}
        </h1>

        {pairs.map((pair, i) => {
          const cell = `min-w-0 article-body${pair.tag === null ? '' : ' article-block'}${
            pair.tag !== null && LEAD.has(pair.tag) ? ' mt-3' : ''
          }`
          // A block showing its source text (failed, or its chunk still on the way) says so; only
          // those pay for the wrapper.
          const translatedCell = (
            <div
              className={cell}
              lang={pair.untranslated ? sourceLang : targetLang}
              data-testid="body-translated"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; model output re-escaped on rehydration (ADR 0005)
              dangerouslySetInnerHTML={{ __html: pair.translated }}
            />
          )
          return (
            <Fragment key={pair.id}>
              <div
                className={`${cell} article-source`}
                lang={sourceLang}
                dir="auto"
                data-testid="body-original"
                // Two columns tile the source cells into one continuous band; only its two ends
                // need the padding and the rounding that every stacked panel gets, and the top
                // end is the title above.
                data-edge-last={i === pairs.length - 1 ? '' : undefined}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; model output re-escaped on rehydration (ADR 0005)
                dangerouslySetInnerHTML={{ __html: pair.original }}
              />
              {pair.untranslated ? (
                <Untranslated pending={pair.pending}>{translatedCell}</Untranslated>
              ) : (
                translatedCell
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
