/**
 * How Tela reads your blog (`/bot`, ADR 0070): what Tela fetches from a blog and how often, what
 * it shows of it, and what stays the writer's, for a writer and for whoever runs their server.
 * For writers and the Dashboard link here. It was For writers' lower half until Tela Public gave
 * it a page of its own; its sections keep their anchors
 * (`#reading`, `#shows`, `#yours`), and an old `/writers#reading` link finds its way here
 * (`pages/writers.tsx`). Pure and without data, so the edge renders it whole from the bundle.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { SiteFooter } from '../components/site-footer'
import { DOC_COLUMN, DocItem, DocItems, DocSection, useDocText } from './doc'
import { BODY, PAGE, QUIET_LINK, STANDFIRST, TEXT_LINK, TITLE } from './public-type'

const READING = ['agent', 'often', 'changed', 'errors', 'images', 'pages'] as const
const SHOWS = ['public', 'members', 'translation'] as const
const YOURS = ['nothing', 'ads', 'translation'] as const

export function BotView({ year }: { year: number }) {
  const t = useTranslations('writers')
  const text = useDocText()
  const point = (section: string, key: string) => (
    <DocItem key={key} id={`${section}-${key}`} title={t(`${section}.${key}.title`)}>
      {text(`${section}.${key}.body`)}
    </DocItem>
  )
  return (
    <>
      <main
        className={`${PAGE} animate-fade pt-[clamp(32px,5.6vw,64px)] pb-[clamp(72px,10vw,120px)]`}
        data-testid="bot-page"
      >
        <div className={DOC_COLUMN}>
          <p className="m-0 mb-3.5 text-[14px]">
            <Link to="/writers" className={QUIET_LINK}>
              <span aria-hidden="true">← </span>
              {t('title')}
            </Link>
          </p>
          <h1 className={`${TITLE} [font-size:calc(clamp(38px,5.4vw,58px)*var(--hs))]`}>
            {t('reading.title')}
          </h1>
          <p
            className={`${STANDFIRST} mt-4 text-body [font-size:calc(clamp(19px,2.1vw,21px)*var(--bs))]`}
          >
            {t('reading.intro')}
          </p>

          <DocSection id="reading" first>
            <DocItems>{READING.map((k) => point('reading', k))}</DocItems>
            {text('reading.check', `${BODY} mt-5`)}
            {text('reading.robots', `${BODY} mt-5`)}
          </DocSection>
          <DocSection id="shows" title={t('shows.title')}>
            <DocItems>{SHOWS.map((k) => point('shows', k))}</DocItems>
          </DocSection>
          <DocSection id="yours" title={t('yours.title')}>
            <DocItems>{YOURS.map((k) => point('yours', k))}</DocItems>
          </DocSection>

          <div className="mt-10 border-t border-line pt-[18px]">
            <Link to="/writers" className={`${TEXT_LINK} text-[15px]`} data-testid="bot-to-writers">
              <span aria-hidden="true">← </span>
              {t('title')}
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter year={year} />
    </>
  )
}
