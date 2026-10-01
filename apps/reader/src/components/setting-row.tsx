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
      className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t border-line py-5"
      data-testid={testId}
    >
      <div className="min-w-0 flex-1 basis-60">
        <div className="font-medium">{label}</div>
        {hint ? <div className="mt-[3px] text-[13px] text-muted">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
