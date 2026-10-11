import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { GEAR, GEAR_VIEWBOX, Glyph } from './glyph'

/**
 * Beside the Subscriptions heading, in the sidebar and in `MobileNav`: the list's own page in
 * Settings, where a blog is left, taken back, imported or exported (Tela v2's "Manage"). A gear,
 * since it opens settings (sliders read as a filter); the quiet button style of the sidebar
 * toggle, and the name in its label and tooltip. `box` is its padding or its size: the sidebar's
 * by default, and a phone's touch target in `MobileNav`.
 */
export function ManageSubscriptions({
  className = '',
  box = 'px-2.5 py-1.5',
}: {
  className?: string
  box?: string
}) {
  const t = useTranslations('sidebar')
  return (
    <Link
      to="/settings/subscriptions"
      aria-label={t('manage')}
      title={t('manage')}
      data-testid="manage-subscriptions"
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink hover:no-underline ${box} ${className}`}
    >
      <Glyph viewBox={GEAR_VIEWBOX} strokeWidth={2.1}>
        {GEAR}
      </Glyph>
    </Link>
  )
}
