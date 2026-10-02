import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import type { InfoPageId } from '../content/info/types'
import { useTitle } from '../lib/title'
import { useUi } from '../ui'
import { InfoView } from '../views/info'

/** About, Privacy or Terms, for anyone: the copy is in the bundle, so nothing is fetched. */
export function InfoPage({ page }: { page: InfoPageId }) {
  const { locale } = useUi()
  useTitle(useTranslations('info')(`tabs.${page}`))
  // The browser scrolls to an anchor only in a page it loaded; arriving at `/privacy#cookies`
  // from another screen of the app is a render, so the section is found here.
  const { hash } = useLocation()
  // biome-ignore lint/correctness/useExhaustiveDependencies: another tab starts at its top
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [hash, page])
  return <InfoView page={page} locale={locale} />
}
