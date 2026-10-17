import { useTranslations } from 'use-intl'
import { toggleFolder } from '../lib/folders-open'
import type { FolderItem } from '../store/selectors'
import { CHEVRON_DOWN, Glyph } from './glyph'

/**
 * A folder's chevron (Tela Lists): opens or closes the folder on this device, and turns a quarter
 * while it is closed. Its name says what it does to which folder ("Collapse Cities"), and
 * `aria-expanded` whether the blogs under it show. `className` is its box: 34px in the sidebar, a
 * phone's 44px target in the Feeds menu. It toggles the folder as it is when pressed.
 */
export function FolderToggle({
  folder,
  open,
  className,
  testId,
}: {
  folder: Pick<FolderItem, 'id' | 'name'>
  open: boolean
  className: string
  testId: string
}) {
  const t = useTranslations('sidebar')
  return (
    <button
      type="button"
      onClick={() => toggleFolder(folder.id)}
      aria-label={t(open ? 'collapseFolder' : 'expandFolder', { name: folder.name })}
      aria-expanded={open}
      className={`flex shrink-0 items-center justify-center rounded-lg text-muted hover:text-ink ${className}`}
      data-testid={testId}
    >
      <Glyph
        size={12}
        strokeWidth={1.8}
        className={`transition-transform duration-[180ms] motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}
      >
        {CHEVRON_DOWN}
      </Glyph>
    </button>
  )
}
