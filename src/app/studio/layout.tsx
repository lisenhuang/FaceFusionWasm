import type { Metadata } from 'next'
import type { ReactNode } from 'react'

/**
 * Metadata for the browser build, which lives here rather than in `page.tsx`
 * because that page is a client component and cannot export it.
 *
 * `noindex`: the site presents Morphiqo as an iOS and macOS app. The browser
 * build still works and anyone with the link can use it, but it is not
 * advertised — it is absent from the landing page, absent from the sitemap, and
 * asks search engines not to list it. Removing `robots` below is all it takes to
 * reverse that.
 */
export const metadata: Metadata = {
  title: { absolute: 'Morphiqo' },
  robots: { index: false, follow: false },
}

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
