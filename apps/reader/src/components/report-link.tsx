/**
 * "Report", on a profile, a blogroll, a blog's page and beside a note (ADR 0059). A member gets a
 * sheet: why, in a few words if they like, and Send; then a calm thank-you. A visitor, who has no
 * account to report with, gets a mail to the contact address with the page's address in it.
 *
 * The edge renders these pages for a guest only, so its cached HTML always holds the visitor's
 * link, and nothing about a member; the app draws the same link over it for a visitor, and the
 * member's button once it knows a member is reading. Both say "Report", in the same place.
 */
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from '@tela/shared'
import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  detailsFit,
  detailsLength,
  type ReportOutcome,
  type ReportSubject,
  reportMailto,
  sendReport,
} from '../lib/reporting'
import { ResponsiveDialog } from './modal'

const LINK = 'text-[12.5px] text-muted hover:text-ink hover:underline'

export function ReportLink({
  subject,
  path,
  member,
  className = '',
}: {
  subject: ReportSubject
  /** The page's own address: what a visitor's mail names, and the sheet sends beside a report. */
  path: string
  /** A member is reading: the sheet, not the mail. */
  member: boolean
  className?: string
}) {
  const t = useTranslations('report')
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  if (!member) {
    return (
      <a
        href={reportMailto(t(`mailSubject.${subject.kind}`), path)}
        className={`${LINK} ${className}`}
        aria-label={t(`byMail.${subject.kind}`)}
        data-testid="report-link"
        data-report={subject.kind}
      >
        {t('link')}
      </a>
    )
  }
  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        className={`cursor-pointer border-0 bg-transparent p-0 ${LINK} ${className}`}
        aria-label={t(`title.${subject.kind}`)}
        aria-haspopup="dialog"
        data-testid="report-link"
        data-report={subject.kind}
      >
        {t('link')}
      </button>
      {open ? (
        <ReportSheet subject={subject} path={path} opener={opener} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

/** Why it is reported, and in what words; what Send says when it goes, or why it did not. */
export function ReportSheet({
  subject,
  path,
  opener,
  onClose,
  send = sendReport,
}: {
  subject: ReportSubject
  path: string
  opener: React.RefObject<HTMLElement | null>
  onClose: () => void
  /** For a test: what Send calls. */
  send?: typeof sendReport
}) {
  const t = useTranslations('report')
  const titleId = useId()
  const detailsId = useId()
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [details, setDetails] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | ReportOutcome>('idle')
  const n = detailsLength(details)
  const ready = reason !== null && detailsFit(details) && state !== 'sending'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || reason === null) return
    setState('sending')
    setState(await send({ subject, reason, details, path, url: window.location.href }))
  }

  // One dialog throughout, the thank-you in the form's place: two would hand focus back to the
  // page between them.
  return (
    <ResponsiveDialog labelledBy={titleId} opener={opener} onClose={onClose} testId="report-sheet">
      {state === 'sent' ? (
        <div className="flex flex-col gap-4" data-testid="report-thanks">
          <h2
            id={titleId}
            className="m-0 font-serif text-[24px] leading-tight font-medium tracking-[-0.01em] md:text-[28px]"
          >
            {t('thanks')}
          </h2>
          <p className="m-0 text-[14px] leading-normal text-ink-2">{t('thanksBody')}</p>
          <div className="flex justify-end pt-1">
            <button
              type="button"
              // biome-ignore lint/a11y/noAutofocus: the sheet's one control once it is sent.
              autoFocus
              onClick={onClose}
              className="rounded-full bg-ink px-5 py-[9px] text-[13.5px] font-medium text-paper hover:brightness-125 max-md:min-h-[46px] max-md:w-full"
              data-testid="report-close"
            >
              {t('close')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2
              id={titleId}
              className="m-0 font-serif text-[24px] leading-tight font-medium tracking-[-0.01em] md:text-[28px]"
            >
              {t(`title.${subject.kind}`)}
            </h2>
            <p className="m-0 text-[13.5px] leading-normal text-ink-2">{t('intro')}</p>
          </div>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] font-medium">{t('why')}</legend>
            {REPORT_REASONS.map((r) => (
              <label
                key={r}
                className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3.5 py-2.5 ${reason === r ? 'border-ink' : 'border-line'}`}
                data-testid={`report-reason-${r}`}
              >
                <input
                  type="radio"
                  name={`${titleId}-reason`}
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="size-4 shrink-0 accent-ink"
                />
                <span className="text-[14px]">{t(`reasons.${r}`)}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={detailsId} className="text-[13px] font-medium">
                {t('details')} <span className="font-normal text-muted">{t('optional')}</span>
              </label>
              <span
                className={`text-[12px] tabular-nums ${n > REPORT_DETAILS_MAX ? 'text-danger' : 'text-muted'}`}
              >
                {t('count', { n, max: REPORT_DETAILS_MAX })}
              </span>
            </div>
            <textarea
              id={detailsId}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              aria-invalid={n > REPORT_DETAILS_MAX}
              className="w-full resize-y rounded-lg border border-thumb bg-surface px-3 py-2.5 text-[15px] leading-[1.45] text-ink outline-none placeholder:text-muted focus:border-muted max-md:text-[16px]"
              data-testid="report-details"
            />
          </div>
          {state === 'rate_limited' || state === 'not_found' || state === 'failed' ? (
            <p className="m-0 text-[13px] text-danger" role="alert" data-testid="report-error">
              {t(`errors.${state}`)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="flex-1 max-md:hidden" />
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3.5 py-2 text-[13.5px] text-muted hover:bg-hover hover:text-ink max-md:min-h-[46px] max-md:flex-1 max-md:border max-md:border-thumb max-md:font-medium max-md:text-ink"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={!ready}
              className="rounded-full bg-ink px-5 py-[9px] text-[13.5px] font-medium text-paper hover:brightness-125 disabled:opacity-40 max-md:min-h-[46px] max-md:flex-[2]"
              data-testid="report-send"
            >
              {state === 'sending' ? t('sending') : t('send')}
            </button>
          </div>
        </form>
      )}
    </ResponsiveDialog>
  )
}
