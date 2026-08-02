/**
 * DocPage.tsx
 *
 * The shell around the two documents the App Store requires a URL for: the
 * support page and the privacy policy.
 *
 * Deliberately a *server* component. Everything else in this app is a client
 * component because it needs workers, WebGPU and OPFS; these two pages need
 * none of that and are pure text, so they prerender to static HTML and stay
 * readable with JavaScript disabled — which matters, because App Review will
 * open them in something that is not the studio.
 *
 * The mark is inlined rather than imported from `ui.tsx`, which is `'use
 * client'`: importing it would pull the whole interactive bundle into a page
 * that has nothing to interact with.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'

/** Where support mail goes. One constant, referenced by both documents. */
export const CONTACT_EMAIL = 'aifydotnz+morphiqo@gmail.com'

/**
 * The date shown as "last updated". Hardcoded rather than `new Date()`: a
 * policy's date is the day its *text* changed, not the day someone loaded it,
 * and a date that moves on its own is worse than no date at all.
 */
export const LAST_UPDATED = '2 August 2026'

export function DocPage({
  title,
  intro,
  children,
}: {
  title: string
  intro: string
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-2xl items-center gap-2.5 px-6 pt-8 sm:pt-12">
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="Morphiqo home">
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
          <span className="text-[15px] font-semibold text-ink-100">Morphiqo</span>
        </Link>
      </header>

      <main className="mx-auto max-w-2xl px-6 pb-20 pt-8">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink-100 sm:text-[30px]">
          {title}
        </h1>
        <p className="mt-3 text-balance text-[15px] leading-relaxed text-ink-300">{intro}</p>
        <p className="mt-2 text-[12.5px] text-ink-400">Last updated {LAST_UPDATED}</p>

        <div className="mt-10 flex flex-col gap-9">{children}</div>

        <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 pt-6 text-[13px] text-ink-400">
          <Link href="/" className="hover:text-ink-100">
            Morphiqo
          </Link>
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

/** One titled block of prose. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[17px] font-semibold text-ink-100">{title}</h2>
      <div className="flex flex-col gap-3 text-[14.5px] leading-relaxed text-ink-200">
        {children}
      </div>
    </section>
  )
}

/** A bulleted list, styled once so neither document has to repeat it. */
export function List({ children }: { children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-ink-500">{children}</ul>
  )
}

/** The callout used for the one or two things a reader must not miss. */
export function Highlight({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl bg-ink-900/60 p-4 text-[14px] leading-relaxed text-ink-200 ring-1 ring-ink-800">
      {children}
    </p>
  )
}

export function MailLink() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent-400 hover:underline">
      {CONTACT_EMAIL}
    </a>
  )
}
