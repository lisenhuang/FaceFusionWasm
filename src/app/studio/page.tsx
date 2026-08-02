'use client'

/**
 * page.tsx
 *
 * Routes between first-run model installation and the studio, and does the one
 * thing that has to happen before either: check that the browser can actually do
 * this at all.
 *
 * The whole app is a client component by necessity — every capability it relies
 * on (workers, WebGPU, WebCodecs, OPFS) exists only in a browser, and there is
 * no server-rendered version of any of it worth showing.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

import { Onboarding } from '@/components/Onboarding'
import { Studio } from '@/components/Studio'
import { IconSparkles, IconWarning, Spinner } from '@/components/ui'
import { useStore } from '@/lib/store'

/**
 * Which of the capabilities the app is built on this browser actually has.
 *
 * Computed once and cached: `useSyncExternalStore` re-reads the snapshot on
 * every render and compares it by identity, so returning a fresh array would
 * loop. The server snapshot is `null`, which renders the splash — there is no
 * meaningful server-side answer to "does your browser have WebCodecs".
 */
let cachedSupport: string[] | null = null

function missingCapabilities(): string[] {
  if (cachedSupport) return cachedSupport
  const missing: string[] = []
  if (typeof Worker === 'undefined') missing.push('Web Workers')
  if (!navigator.storage?.getDirectory) missing.push('Origin Private File System')
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    missing.push('WebCodecs')
  }
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas')
  cachedSupport = missing
  return missing
}

const subscribeToNothing = () => () => {}

export default function Page() {
  const missing = useSyncExternalStore(
    subscribeToNothing,
    missingCapabilities,
    () => null,
  )
  const [booted, setBooted] = useState(false)
  const modelsReady = useStore((state) => state.modelsReady)
  // The required models land before the optional ones, so `modelsReady` flips
  // partway through an install. Switching screens at that moment would hide the
  // progress bar for a download the user was told was 903 MB and has only seen
  // half of.
  const installing = useStore((state) => state.library?.isWorking ?? false)
  const boot = useStore((state) => state.boot)

  useEffect(() => {
    if (missingCapabilities().length > 0) return
    void boot().finally(() => setBooted(true))
  }, [boot])

  if (missing === null) return <Splash />
  if (missing.length > 0) return <Unsupported missing={missing} />
  if (!booted) return <Splash />

  return modelsReady && !installing ? <Studio /> : <Onboarding />
}

function Splash() {
  return (
    <div className="grid h-dvh place-items-center">
      <div className="flex flex-col items-center gap-3 text-ink-400">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-600/12 ring-1 ring-accent-600/25">
          <IconSparkles className="h-6 w-6 text-accent-400" />
        </span>
        <span className="flex items-center gap-2 text-[13px]">
          <Spinner className="h-3.5 w-3.5" />
          Starting…
        </span>
      </div>
    </div>
  )
}

function Unsupported({ missing }: { missing: string[] }) {
  return (
    <main className="mx-auto grid h-dvh max-w-lg place-items-center px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-warn-500/10 ring-1 ring-warn-500/25">
          <IconWarning className="h-6 w-6 text-warn-500" />
        </span>
        <h1 className="text-xl font-semibold">This browser is missing some pieces</h1>
        <p className="text-[13.5px] leading-relaxed text-ink-300">
          Face swapping runs entirely on your device, which needs a few recent browser
          features. This one does not have {formatList(missing)}.
        </p>
        <p className="text-[12.5px] text-ink-400">
          Chrome or Edge 121+, Safari 17+, or a recent Chrome on Android will work. There
          is no server-side fallback, by design.
        </p>
      </div>
    </main>
  )
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}
