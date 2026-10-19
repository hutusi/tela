/**
 * `text` with every query string cut from the addresses in it: what a browser's error report
 * (`apps/reader/src/lib/report.ts`) and tela-api's log of it (`/api/client-errors`) both keep, so
 * the two never disagree on what is redacted. `/join?code=…` is someone's invitation. Over-cutting
 * a stray `?` in prose is fine.
 */
export function withoutQueries(text: string): string {
  return text.replace(/(?<=[\w/.%-])\?[^\s)'"`<>#]*/g, '')
}
