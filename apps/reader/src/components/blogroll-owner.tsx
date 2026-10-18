/**
 * The owner's tools under their blogroll's title (ADR 0050, Tela Lists): who can see it, as a pill
 * that says Public or Private and switches it; Edit, which opens the dialog; Add blogs, which opens
 * the checklist of their subscriptions under the row (a sheet on a phone); and Copy link. Each
 * change is made at once, with no Undo (only Remove, Delete and Subscribe to all are held). Making
 * it public waits while this device's last change to the switch is on its way, as the profile's
 * privacy switches do (issue #16).
 */
import type { BlogrollRow } from '@tela/sync'
import { useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { blogrollHref } from '../lib/blogroll-href'
import { showToast } from '../lib/toasts'
import { useStore } from '../store/hooks'
import { QUIET_PILL } from '../views/blogroll'
import { AddBlogs } from './add-blogs'
import { BlogrollDialog, useBlogrollPublicUnsettled } from './blogroll-dialog'
import { Glyph } from './glyph'

/** A padlock: only the owner can open it. */
const LOCK = (
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
  </>
)

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
  const { store } = useStore()
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const unsettled = useBlogrollPublicUnsettled(row.id)
  const locked = !row.isPublic && unsettled

  const switchPublic = () => {
    if (row.isPublic) {
      store.setBlogrollPublic(row.id, false)
      showToast(t('madePrivate'))
    } else if (!unsettled) {
      store.setBlogrollPublic(row.id, true)
      showToast(t('madePublic'))
    }
  }
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
        <button
          type="button"
          onClick={switchPublic}
          disabled={locked}
          title={locked ? td('publicWait') : t('switchTitle')}
          aria-label={t('whoIs', { state: row.isPublic ? td('public') : td('private') })}
          className={QUIET_PILL}
          data-testid="blogroll-public-toggle"
          data-public={row.isPublic ? 1 : 0}
        >
          {row.isPublic ? null : (
            <Glyph size={13} className="block shrink-0">
              {LOCK}
            </Glyph>
          )}
          {row.isPublic ? td('public') : td('private')}
        </button>
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
