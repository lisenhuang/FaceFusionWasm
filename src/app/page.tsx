/**
 * The landing page for the iOS and macOS apps.
 *
 * A *server* component, unlike everything else in this app. That is the point:
 * the studio is a client component that renders a spinner until WebGPU and a
 * worker are up, so a crawler reading `/` used to learn nothing at all about
 * the product. This page is the text a search engine and an answer engine
 * actually get to read.
 *
 * It describes the iOS and macOS apps only. The browser build still exists at
 * `/studio`, but it is not mentioned here, not linked from here, and not in the
 * sitemap — see `APP_STORE_URL` in `lib/site.ts` for why.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { APP_STORE_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, absoluteURL } from '@/lib/site'

const TITLE = 'Morphiqo — on-device face swap for iPhone, iPad and Mac'

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { title: TITLE, description: SITE_DESCRIPTION, url: '/' },
}

/**
 * What an answer engine reads when it wants facts rather than prose. Declared
 * here rather than in the layout so it describes the shipping apps — the layout
 * covers every route, including ones that are not the product.
 */
const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'MobileApplication',
  '@id': absoluteURL('/#app'),
  name: SITE_NAME,
  url: SITE_URL,
  installUrl: APP_STORE_URL,
  applicationCategory: 'MultimediaApplication',
  applicationSubCategory: 'Photo & video editing',
  operatingSystem: 'iOS 17 or later, iPadOS 17 or later, macOS 14 or later',
  description: SITE_DESCRIPTION,
  featureList: [
    'Swap faces in video and in photos',
    'Runs entirely on the device — no upload, no server, no account',
    'Works offline after a one-time model download',
    'Choose which face in a scene is replaced',
    'Optional detail enhancement on the swapped face',
  ],
  privacyPolicy: absoluteURL('/privacy'),
  termsOfService: absoluteURL('/terms'),
}

export default function HomePage() {
  return (
    <div className="min-h-dvh">
      <script
        type="application/ld+json"
        // A literal defined above; nothing user-supplied reaches it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <header className="mx-auto flex max-w-3xl items-center gap-2.5 px-6 pt-8 sm:pt-12">
        <Mark />
        <span className="text-[15px] font-semibold text-ink-100">Morphiqo</span>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-14 sm:pt-20">
        <h1 className="text-balance text-[34px] font-semibold leading-[1.1] tracking-tight text-ink-100 sm:text-[46px]">
          Face swapping that never leaves your device
        </h1>
        <p className="mt-5 max-w-xl text-balance text-[16px] leading-relaxed text-ink-300 sm:text-[17px]">
          Morphiqo swaps faces in videos and photos on your iPhone, iPad or Mac. The work
          happens on your own hardware — nothing is uploaded, because there is no server to
          upload it to.
        </p>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <StoreButton href={APP_STORE_URL} primary>
            Download for iPhone &amp; iPad
          </StoreButton>
          <StoreButton href={APP_STORE_URL}>Download for Mac</StoreButton>
        </div>
        <p className="mt-4 text-[13px] text-ink-400">
          Requires iOS 17 or later, or macOS 14 or later. Apple silicon and Intel Macs are
          both supported.
        </p>

        <section className="mt-20 grid gap-x-10 gap-y-12 sm:grid-cols-2">
          <Feature title="Nothing is uploaded">
            Detection, matching, swapping and enhancement all run locally. Your photos and
            videos are never transmitted, and no account is ever created — there is nothing
            to sign up for and nothing to sign in to.
          </Feature>
          <Feature title="Works offline">
            The app fetches its AI models once, then works with the network switched off
            entirely. On a plane, on a train, or with the radio off — it behaves the same.
          </Feature>
          <Feature title="Video, not just stills">
            Swap a face across an entire clip, with the audio carried through untouched.
            Scrub the result before you commit to exporting it.
          </Feature>
          <Feature title="You choose the face">
            When a scene has several people in it, pick the one to replace rather than
            hoping the automatic match agrees with you.
          </Feature>
          <Feature title="Exports stay anonymous">
            A finished file carries no tag saying what produced it, and the original
            photo&rsquo;s location and camera metadata do not survive the swap.
          </Feature>
          <Feature title="Built for both platforms">
            The iPhone, iPad and Mac apps run the same pipeline and are checked against
            each other, so the same inputs give you the same result.
          </Feature>
        </section>

        <section className="mt-20 rounded-2xl bg-ink-900/60 p-6 ring-1 ring-ink-800 sm:p-8">
          <h2 className="text-[19px] font-semibold text-ink-100">
            Only swap faces of people who have agreed to it
          </h2>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-300">
            Morphiqo alters images of real people. You are responsible for having the right
            to use the media you process and for what you do with the result. The{' '}
            <Link href="/terms" className="text-accent-400 hover:underline">
              terms of use
            </Link>{' '}
            set out what that means.
          </p>
        </section>

        <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 pt-6 text-[13px] text-ink-400">
          <span>© {2026} Morphiqo</span>
          <Link href="/support" className="hover:text-ink-100">
            Support
          </Link>
          <Link href="/privacy" className="hover:text-ink-100">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-ink-100">
            Terms
          </Link>
        </footer>
      </main>
    </div>
  )
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[16px] font-semibold text-ink-100">{title}</h2>
      <p className="text-[14.5px] leading-relaxed text-ink-300">{children}</p>
    </div>
  )
}

/**
 * A plain styled link rather than Apple's official badge artwork, which has its
 * own brand guidelines and has to be used unmodified and at approved sizes. Drop
 * the real badges in here when you are ready to follow them.
 */
function StoreButton({
  href,
  primary,
  children,
}: {
  href: string
  primary?: boolean
  children: ReactNode
}) {
  return (
    <a
      href={href}
      className={[
        'inline-flex items-center justify-center rounded-xl px-6 py-3.5 text-[15px] font-medium',
        'transition-colors',
        primary
          ? 'bg-accent-600 text-white hover:bg-accent-500'
          : 'bg-ink-800 text-ink-100 ring-1 ring-ink-700 hover:bg-ink-700',
      ].join(' ')}
    >
      {children}
    </a>
  )
}

function Mark() {
  return (
    <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-600/15 ring-1 ring-accent-600/25">
      <svg
        viewBox="0 0 24 24"
        className="h-4.5 w-4.5 text-accent-400"
        aria-hidden
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9 12 3.5Z" />
        <path d="M18.5 4v3M20 5.5h-3M5.5 16v2.5M6.75 17.25h-2.5" />
      </svg>
    </span>
  )
}
