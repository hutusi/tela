import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { Glyph, SLIDERS } from './glyph'

/**
 * Beside the Subscriptions heading, in the sidebar and in `MobileNav`: the list's own page in
 * Settings, where a blog is left, taken back, imported or exported (Tela v2's "Manage"). The quiet
 * button style of the sidebar toggle; the name is in its label and tooltip.
 */
export function ManageSubscriptions({ className = '' }: { className?: string }) {
  const t = useTranslations('sidebar')
  return (
    <Link
      to="/settings/subscriptions"
      aria-label={t('manage')}
      title={t('manage')}
      data-testid="manage-subscriptions"
      className={`inline-flex shrink-0 rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink hover:no-underline ${className}`}
    >
      <Glyph>{SLIDERS}</Glyph>
    </Link>
  )
}
