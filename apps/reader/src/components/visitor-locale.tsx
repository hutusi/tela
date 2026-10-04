/**
 * "Read in EN ▾": a visitor's language, in the header and on the sign-in page (ADR 0035), the
 * same menu as a member's (`ReadInMenu`). It sets the interface language, and with it the language
 * titles are translated into, since a visitor reads in their interface language
 * (`useReadingLang`). A member has Settings → Language and their own Read in instead.
 *
 * The edge's page marks the language it was rendered in, which is right for every visitor it is
 * cached for, since the cache is kept per language; choosing needs the script, which writes the
 * cookie the edge renders by.
 */
import { UI_LOCALES } from '@tela/shared'
import { useUi } from '../ui'
import { ReadInMenu } from './read-in-menu'

export function VisitorLocale({ className }: { className: string }) {
  const { locale, setLocale } = useUi()
  return (
    <ReadInMenu
      options={UI_LOCALES}
      value={locale}
      onChoose={setLocale}
      className={className}
      testId="visitor-locale"
    />
  )
}
