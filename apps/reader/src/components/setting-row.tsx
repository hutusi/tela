/**
 * A row's label column. On a phone (below `sm`) it starts from nothing and grows into what its
 * control leaves, so Reading's segmented choices fit beside their labels at 360px in English,
 * French and Chinese (the widest, French Line length, is 197px of Settings' 320 and leaves the
 * label 107). It keeps 96px, and a control that would leave it less wraps under it, as Default
 * view's does at 360px. From `sm` up it asks for 240px, as it always has.
 */
export const SETTING_LABEL = 'min-w-24 flex-1 basis-0 sm:min-w-0 sm:basis-60'

/** The line under a row's label that says what it does. */
export const SETTING_HINT = 'mt-[3px] text-[12.5px] text-muted sm:text-[13px]'

/** One setting: what it is and what it does on the left, its control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  testId,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
  testId?: string
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-line py-4 sm:gap-x-8 sm:py-5"
      data-testid={testId}
    >
      <div className={SETTING_LABEL}>
        <div className="font-medium">{label}</div>
        {hint ? <div className={SETTING_HINT}>{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
