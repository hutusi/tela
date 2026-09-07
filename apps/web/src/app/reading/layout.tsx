import { AppHeader } from '@/components/app-header'

/**
 * The header lives here rather than in the page so it survives navigation between articles:
 * Next does not re-render a layout when only its child changes, and a Suspense boundary below it
 * can flush it to the browser before any query has come back.
 */
export default function ReadingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader active="reading" />
      {children}
    </>
  )
}
