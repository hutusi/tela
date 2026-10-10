/** What Discover's four tabs share (ADR 0044): the page, its heading and intro, and the tabs. */
import { useTranslations } from 'use-intl'
import { DiscoverTabs } from '../components/discover-tabs'
import type { DiscoverTab } from '../lib/discover-href'

export function DiscoverFrame({ tab, children }: { tab: DiscoverTab; children: React.ReactNode }) {
  const t = useTranslations('discover')
  return (
    <main
      className="mx-auto w-full max-w-[1120px] flex-1 px-4 pt-8 pb-24 animate-fade md:px-12 md:pt-11"
      data-testid={`discover-${tab}`}
    >
      <h1 className="m-0 mb-1.5 font-serif text-[32px] leading-[1.1] font-medium tracking-[-0.015em] md:mb-2 md:text-[40px]">
        {t('title')}
      </h1>
      <p className="m-0 mb-5 max-w-[620px] text-[14.5px] leading-normal text-ink-2 md:mb-7 md:text-[15px]">
        {t('intro')}
      </p>
      <DiscoverTabs tab={tab} />
      {children}
    </main>
  )
}
