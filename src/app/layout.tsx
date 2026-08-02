import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Morphiqo — local face swapping',
  description:
    'Swap faces in video and photos entirely in your browser. Your media never leaves your device.',
  applicationName: 'Morphiqo',
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  // Matches `--color-ink-950` in each appearance, so the iOS status bar and the
  // Android chrome sit flush against the page instead of banding against it.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fc' },
    { media: '(prefers-color-scheme: dark)', color: '#08090c' },
  ],
  width: 'device-width',
  initialScale: 1,
  // The preview canvas is pinch-zoomable content; blocking that would make
  // judging a swap on a phone needlessly hard.
  maximumScale: 5,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        {children}
        {/*
          Page-view counting for the site. Cookieless and aggregate — it records
          that a page was visited, not who visited it, and it never sees the
          media the studio is working on, which is never uploaded in the first
          place.

          It sits in the root layout, so it covers the studio at `/` as well as
          the document pages. That is a deliberate second network request on a
          site whose whole claim is that it makes one; `/privacy` says so
          explicitly, and must keep saying so.
        */}
        <Analytics />
      </body>
    </html>
  )
}
