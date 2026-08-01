import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FaceFusion Web — local face swapping',
  description:
    'Swap faces in video and photos entirely in your browser. Your media never leaves your device.',
  applicationName: 'FaceFusion Web',
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#08090c',
  width: 'device-width',
  initialScale: 1,
  // The preview canvas is pinch-zoomable content; blocking that would make
  // judging a swap on a phone needlessly hard.
  maximumScale: 5,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  )
}
