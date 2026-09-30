import { useEffect } from 'react'

/** "Discover · Tela", or "Tela" alone. */
export function pageTitle(title: string | null | undefined): string {
  return title ? `${title} · Tela` : 'Tela'
}

export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = pageTitle(title)
  }, [title])
}
