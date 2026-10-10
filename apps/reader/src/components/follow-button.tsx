/**
 * Follow and Following (ADR 0031): a mutation, so the button changes at once and the push goes
 * behind it. A visitor's Follow is a link to sign in that comes back to the page.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import type { MemberControls, Person } from '../views/types'

export function FollowButton({
  person,
  member,
  next,
  small = false,
  testId = 'follow-suggested',
}: {
  person: Person
  member: MemberControls | undefined
  /** Where a visitor comes back to once signed in. */
  next: string
  small?: boolean
  testId?: string
}) {
  const t = useTranslations('following')
  const shape = `shrink-0 rounded-full border font-medium whitespace-nowrap ${
    small ? 'px-[11px] py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]'
  }`
  if (!member) {
    return (
      <Link
        to={`/login?next=${encodeURIComponent(next)}`}
        className={`${shape} border-ink bg-ink text-paper hover:no-underline`}
        data-testid={testId}
      >
        {t('follow')}
      </Link>
    )
  }
  const on = member.isFollowing(person.id)
  // Named by what a follow needs, not by whatever else the page knows of them.
  const named: Person = {
    id: person.id,
    handle: person.handle,
    displayName: person.displayName,
    avatar: person.avatar ?? null,
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => member.setFollowing(named, !on)}
      className={`${shape} ${on ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'}`}
      data-testid={testId}
    >
      {on ? t('followingButton') : t('follow')}
    </button>
  )
}
