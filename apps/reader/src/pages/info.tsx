import { useEffect, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useTranslations } from 'use-intl'
import type { InfoPageId } from '../content/info/types'
import { useTitle } from '../lib/title'
import { useUi } from '../ui'
import { InfoView } from '../views/info'

/** About, Privacy or Terms, for anyone: the copy is in the bundle, so nothing is fetched. */
export function InfoPage({ page }: { page: InfoPageId }) {
  const { locale } = useUi()
  const [year] = useState(() => new Date().getFullYear())
  useTitle(useTranslations('info')(`tabs.${page}`))
  // The browser scrolls to an anchor only in a page it loaded; arriving at `/privacy#cookies`
  // from another screen of the app is a render, so the section is found here.
  const { hash } = useLocation()
  // A page a link opened (another tab, the footer) starts at its top. One the browser opened, by a
  // load, a reload, Back or Forward (`POP`), stays where the browser put it: at first that is the
  // edge's copy, which the reader may already have scrolled before the app took it over.
  const navigation = useNavigationType()
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each tab and anchor, as it was reached
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
    else if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [hash, page])
  return <InfoView page={page} locale={locale} year={year} />
}
