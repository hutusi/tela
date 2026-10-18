import { BLOGROLL_NAME_MAX } from './constants'

/**
 * A blogroll's id (ADR 0050): minted by the client, as a folder's is, but short, since it is the
 * blogroll's address (`/l/<id>`). Twelve letters and digits are 71 bits: two members never mint
 * the same one, and a private blogroll is refused to anyone else whether they guess it or not.
 */
export const BLOGROLL_ID = /^[A-Za-z0-9]{12}$/

/** Cut to at most `max` code points, so a cut never splits a surrogate pair. */
function cut(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('') : text
}

/**
 * A blogroll's name as it is kept: trimmed, inner runs of space made one, no control characters
 * (tela-api refuses a name with one), and no longer than a name may be. Empty means no name.
 */
export function blogrollName(raw: string): string {
  return cut(
    raw
      .replace(/\s+/g, ' ')
      .replace(/\p{Cc}/gu, '')
      .trim(),
    BLOGROLL_NAME_MAX,
  ).trim()
}

/**
 * A description or a note as it is kept: line breaks stay (as `\n`), every other control
 * character goes, and the ends are trimmed. tela-api refuses one that still has a control
 * character other than a line break.
 */
export function blogrollText(raw: string, max: number): string {
  return cut(
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/[^\P{Cc}\n]/gu, '')
      .trim(),
    max,
  ).trim()
}

/** Whether text holds a control character, a line break aside when `allowNewline`. */
export function hasControl(text: string, allowNewline: boolean): boolean {
  return allowNewline ? /[^\P{Cc}\n]/u.test(text) : /\p{Cc}/u.test(text)
}

/**
 * The length a person sees, in code points: what a counter shows and what the limits count.
 * SQLite's `length()` counts characters the same way.
 */
export const textLength = (text: string) => Array.from(text).length
