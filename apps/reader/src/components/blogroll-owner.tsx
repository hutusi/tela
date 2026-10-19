/**
 * The owner's tools under their blogroll's title (ADR 0050, Tela Lists): who can see it, said and
 * not switched here; Edit, which opens the dialog, where it is changed; Add blogs, which opens the
 * checklist of their subscriptions under the row (a sheet on a phone); and Copy link. Public or
 * private was first a pill that switched at a press, with no Undo: one stray tap published a
 * blogroll, to Discover too and for minutes of caches, or broke every link to it. In Edit it is a
 * choice that says what each means, and takes Save.
 */
import type { BlogrollRow } from '@tela/sync'
import { useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { blogrollHref } from '../lib/blogroll-href'
import { showToast } from '../lib/toasts'
import { QUIET_PILL } from '../views/blogroll'
import { AddBlogs } from './add-blogs'
import { BlogrollDialog } from './blogroll-dialog'
import { Glyph, LOCK } from './glyph'

export function BlogrollOwner({
  row,
  adding,
  onAdding,
  addButton,
}: {
  row: BlogrollRow
  /** Add blogs is open: the page's, since its empty state opens it too. */
  adding: boolean
  onAdding: (open: boolean) => void
  /** Add blogs, which focus goes back to when the checklist closes. */
  addButton: React.RefObject<HTMLButtonElement | null>
}) {
  const t = useTranslations('blogroll.owner')
  const td = useTranslations('blogroll.dialog')
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const state = row.isPublic ? td('public') : td('private')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${blogrollHref(row.id)}`)
      showToast(row.isPublic ? t('copied') : t('copiedPrivate'))
    } catch {
      showToast(t('copyFailed'))
    }
  }

  return (
    <>
      <div className="flex flex-wrap justify-center gap-2">
        <span
          className="relative inline-flex items-center px-2 py-2 text-muted"
          data-testid="blogroll-visibility"
          data-public={row.isPublic ? 1 : 0}
        >
          <span aria-hidden="true" className="inline-flex items-center gap-[7px]">
            {row.isPublic ? null : (
              <Glyph size={13} className="block shrink-0">
                {LOCK}
              </Glyph>
            )}
            {state}
          </span>
          <span className="sr-only">{t('whoIs', { state })}</span>
        </span>
        <button
          ref={editButton}
          type="button"
          onClick={() => setEditing(true)}
          className={QUIET_PILL}
          data-testid="blogroll-edit"
        >
          {t('edit')}
        </button>
        <button
          ref={addButton}
          type="button"
          aria-expanded={adding}
          onClick={() => onAdding(!adding)}
          className={QUIET_PILL}
          data-testid="blogroll-add-blogs"
        >
          {t('addBlogs')}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          className={QUIET_PILL}
          data-testid="blogroll-copy-link"
        >
          {t('copyLink')}
        </button>
      </div>
      {adding ? (
        <AddBlogs blogrollId={row.id} opener={addButton} onClose={() => onAdding(false)} />
      ) : null}
      {editing ? (
        <BlogrollDialog
          editing={row.id}
          opener={editButton.current}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  )
}
