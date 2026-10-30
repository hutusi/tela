/**
 * How Tela reads your blog (`/bot`, ADR 0070), for anyone. The page itself is `views/bot.tsx`,
 * which the edge renders too.
 */
import { useEffect, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useTranslations } from 'use-intl'
import { safeDecode } from '../lib/safe-decode'
import { useTitle } from '../lib/title'
import { BotView } from '../views/bot'

export function BotPage() {
  const t = useTranslations('writers.reading')
  useTitle(t('title'))
  const [year] = useState(() => new Date().getFullYear())

  // An anchor reached from another screen of the app (For writers' old `#reading`) is a render,
  // not a load, so the section is found here; one the browser loaded, it found itself, in the
  // edge's copy (as on For writers).
  const { hash } = useLocation()
  const navigation = useNavigationType()
  useEffect(() => {
    if (hash.length > 1) {
      const id = safeDecode(hash.slice(1))
      if (id) document.getElementById(id)?.scrollIntoView()
    } else if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [hash, navigation])

  return <BotView year={year} />
}
