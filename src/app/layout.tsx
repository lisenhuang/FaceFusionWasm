import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL, absoluteURL } from '@/lib/site'
import './globals.css'

export const metadata: Metadata = {
  // Every relative URL below — canonicals, the Open Graph image — resolves
  // against this. Without it Next emits relative og:image paths, which most
  // crawlers and every social scraper refuse to follow.
  metadataBase: new URL(SITE_URL),

  // The default carries the keywords a cold search needs; the template keeps
  // the brand on every other page without each one repeating it.
  title: {
    default: 'Morphiqo — on-device face swap for video and photos',
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,

  // Not a ranking signal at Google since 2009, but answer engines and several
  // smaller crawlers still read them, and they cost nothing.
  keywords: [
    'face swap',
    'face swap app',
    'on-device face swap',
    'offline face swap',
    'private face swap',
    'video face swap',
    'photo face swap',
    'deepfake alternative',
    'browser face swap',
    'iOS face swap app',
    'Mac face swap app',
  ],

  authors: [{ name: 'Lisen Huang' }],
  creator: 'Lisen Huang',
  publisher: 'Lisen Huang',

  alternates: { canonical: '/' },

  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: SITE_URL,
    title: 'Morphiqo — on-device face swap for video and photos',
    description: SITE_DESCRIPTION,
    locale: 'en_US',
  },

  twitter: {
    card: 'summary_large_image',
    title: 'Morphiqo — on-device face swap for video and photos',
    description: SITE_DESCRIPTION,
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },

  category: 'technology',
  formatDetection: { telephone: false, address: false, email: false },
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

/**
 * What an answer engine reads when it wants facts rather than prose.
 *
 * The studio at `/` is a client component that renders almost no text, so a
 * crawler that only reads the DOM learns very little about what this is. This
 * is where the product is actually described in a form a machine can quote:
 * what it does, which platforms it runs on, and the one claim that
 * distinguishes it.
 */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': absoluteURL('/#website'),
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': absoluteURL('/#app'),
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Photo & video editing',
      operatingSystem: 'Web browser, iOS 17 or later, macOS 14 or later',
      description: SITE_DESCRIPTION,
      browserRequirements:
        'Requires WebGPU or WebAssembly, Web Workers, WebCodecs and the Origin Private File System. Chrome or Edge 121+, Safari 17+.',
      featureList: [
        'Swap faces in video and in photos',
        'Runs entirely on the device — no upload, no server, no account',
        'Works offline after a one-time model download',
        'Optional detail enhancement on the swapped face',
        'Choose which face in a scene is replaced',
      ],
      privacyPolicy: absoluteURL('/privacy'),
      termsOfService: absoluteURL('/terms'),
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <script
          type="application/ld+json"
          // The content is a literal defined above, not anything a user can
          // reach, so there is nothing here to inject.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
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
