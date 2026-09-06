import type { Metadata } from 'next'
import { EB_Garamond, Figtree } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import { isPrivateBeta } from '@/lib/platform/env'
import './globals.css'

// next/font self-hosts these at build time: no runtime request to Google Fonts,
// which matters for readers in mainland China.
const garamond = EB_Garamond({
  variable: '--font-garamond',
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
})

const figtree = Figtree({
  variable: '--font-figtree',
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app')
  return {
    title: { default: t('name'), template: `%s · ${t('name')}` },
    description: t('tagline'),
    // Belt and braces with robots.txt: a page reached directly is not indexed either.
    ...(isPrivateBeta() ? { robots: { index: false, follow: false } } : {}),
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  return (
    <html lang={locale} className={`${garamond.variable} ${figtree.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
