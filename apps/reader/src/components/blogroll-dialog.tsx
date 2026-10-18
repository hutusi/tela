/**
 * New blogroll and Edit blogroll (ADR 0050): a centred dialog from `md`, a bottom sheet below.
 * It makes its own changes: Create makes the blogroll (with `initial.feedIds` in it, from a
 * folder) and opens its page; Save changes the name and description; Delete blogroll deletes it,
 * held while its Undo shows.
 *
 * STUB: slice 3 (the blogroll page) writes this dialog. The props are the contract the profile tab
 * (New blogroll) and Settings (Make a blogroll…) open it with.
 */
export type BlogrollDialogProps = {
  /** Editing this blogroll of the member's; absent, the dialog makes a new one. */
  editing?: string
  /** A new blogroll's starting name and blogs: Make a blogroll from a folder. */
  initial?: { name: string; feedIds: number[] }
  /** The control that opened it, to return focus to. */
  opener?: HTMLElement | null
  onClose: () => void
}

export function BlogrollDialog(_props: BlogrollDialogProps) {
  return null
}
