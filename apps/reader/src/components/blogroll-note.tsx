/**
 * The owner's note on a blog in their blogroll (ADR 0050, Tela Lists): "Add a note" under a blog
 * without one, the note itself under a blog with one, either opening the editor in place. The
 * editor is a serif textarea with a count of the limit, Cancel and Save note; ⌘/Ctrl+Enter saves
 * and Esc cancels. Saving sends `noteBlog` at once, with no Undo: an empty note clears it. Others
 * see the note as written, never translated.
 */
import { BLOGROLL_NOTE_MAX, blogrollText, textLength } from '@tela/shared'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { useStore } from '../store/hooks'
import { BlogrollNoteText } from '../views/blogroll'
import type { Person } from '../views/types'

export function BlogrollNote({
  blogrollId,
  feedId,
  name,
  note,
  owner,
}: {
  blogrollId: string
  feedId: number
  /** The blog's name, which the editor's label and the note's button name. */
  name: string
  note: string | null
  owner: Pick<Person, 'handle' | 'displayName' | 'avatar'>
}) {
  const t = useTranslations('blogroll.note')
  const tb = useTranslations('blogroll')
  const { store } = useStore()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  /** The note as the editor opened on it: Save sends only a change the member made. */
  const [openedWith, setOpenedWith] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // Closing the editor puts focus back on what opened it, which is back by then.
  const returning = useRef(false)
  useLayoutEffect(() => {
    if (editing || !returning.current) return
    returning.current = false
    button.current?.focus()
  }, [editing])
  useEffect(() => {
    if (!editing) return
    const el = input.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const open = () => {
    setValue(note ?? '')
    setOpenedWith(note ?? null)
    setEditing(true)
  }
  const close = () => {
    returning.current = true
    setEditing(false)
  }
  const length = textLength(value.trim())
  const over = length > BLOGROLL_NOTE_MAX
  const save = () => {
    if (over) return
    const kept = blogrollText(value, BLOGROLL_NOTE_MAX)
    const next = kept === '' ? null : kept
    // Only what the member changed: a note written on another device while this editor was open
    // is not overwritten with the one it opened with.
    if (next !== openedWith) store.mutate({ type: 'noteBlog', blogrollId, feedId, note: next })
    close()
  }

  if (editing) {
    return (
      <div className="mt-1.5 flex animate-fade flex-col gap-1.5">
        <textarea
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            }
          }}
          rows={2}
          placeholder={t('placeholder')}
          aria-label={t('label', { name })}
          aria-invalid={over}
          className="w-full resize-y rounded-lg border border-thumb bg-surface px-2.5 py-2 font-serif text-[17px] leading-[1.4] text-ink outline-none placeholder:text-muted focus:border-muted"
          data-testid="blogroll-note-input"
        />
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`mr-auto text-[12px] tabular-nums ${over ? 'text-danger' : 'text-muted'}`}
            data-testid="blogroll-note-count"
          >
            {tb('count', { n: length, max: BLOGROLL_NOTE_MAX })}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-md px-2.5 py-[5px] text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={over}
            className="rounded-full bg-ink px-3 py-[5px] text-[12.5px] font-medium text-paper hover:brightness-125 disabled:opacity-40"
            data-testid="blogroll-note-save"
          >
            {t('save')}
          </button>
        </div>
      </div>
    )
  }
  if (note) {
    return (
      <button
        ref={button}
        type="button"
        onClick={open}
        title={t('editTitle')}
        className="-mx-1.5 cursor-text self-stretch rounded-lg px-1.5 pb-1 text-left hover:bg-hover"
        data-testid="blogroll-note"
      >
        <span className="sr-only">{t('edit', { name })} </span>
        <BlogrollNoteText note={note} owner={owner} me />
      </button>
    )
  }
  return (
    <button
      ref={button}
      type="button"
      onClick={open}
      aria-label={t('addTo', { name })}
      className="mt-1 self-start text-[13px] text-muted hover:text-ink"
      data-testid="blogroll-note"
    >
      {t('add')}
    </button>
  )
}
