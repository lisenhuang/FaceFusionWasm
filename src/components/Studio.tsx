'use client'

/**
 * Studio.tsx
 *
 * The main workspace: pick a face, pick a video, judge the result on a single
 * frame, then export.
 *
 * Two layouts of the same parts. Wide, it is the macOS window — a fixed sidebar
 * beside a preview that fills what is left. Narrow, the preview takes the top of
 * the screen and the settings scroll underneath it, because on a phone the
 * preview is the thing you are looking at and the sidebar is the thing you
 * occasionally reach for.
 */

import { useEffect, useState } from 'react'

import { useStore } from '@/lib/store'
import { ActionBar } from './ActionBar'
import { PreviewCanvas } from './PreviewCanvas'
import { Scrubber } from './Scrubber'
import { SettingsPanel } from './SettingsPanel'
import { IconSparkles, cx } from './ui'

export function Studio() {
  const handleDrop = useStore((state) => state.handleDrop)
  const [dragging, setDragging] = useState(false)

  // Dropping anywhere on the window works, so the counter has to survive the
  // dragleave that fires every time the pointer crosses a child element.
  useEffect(() => {
    let depth = 0
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
    }
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      depth += 1
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      depth = 0
      setDragging(false)
      const file = event.dataTransfer?.files?.[0]
      if (file) void handleDrop(file)
    }

    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [handleDrop])

  return (
    <div className="relative flex h-dvh flex-col">
      {/*
        The export bar sits outside the split so it is pinned to the bottom of
        the window in both layouts. On a phone that is the difference between a
        button that is always reachable and one that scrolls away under the
        settings.
      */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Sidebar — beside the preview when there is room, under it when there is not. */}
        <aside
          className={cx(
            'ff-scroll ff-panel order-2 min-h-0 flex-1 overflow-y-auto border-ink-800',
            'border-t lg:order-1 lg:h-full lg:w-[312px] lg:flex-none lg:border-r lg:border-t-0',
          )}
        >
          <div className="px-4 py-4 lg:py-5">
            <Header />
            <SettingsPanel />
          </div>
        </aside>

        {/* Preview column. A fixed slice of the screen on a phone, the rest of
            the window on a desktop. */}
        <div className="order-1 flex flex-none flex-col lg:order-2 lg:min-h-0 lg:flex-1">
          <div className="h-[38dvh] p-3 sm:p-4 lg:h-auto lg:min-h-0 lg:flex-1">
            <PreviewCanvas />
          </div>
          <Scrubber />
        </div>
      </div>

      <ActionBar />

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-ink-950/70 backdrop-blur-sm">
          <div className="rounded-2xl bg-ink-900 px-6 py-5 text-center ring-2 ring-accent-500">
            <p className="text-[15px] font-medium">Drop to use this file</p>
            <p className="mt-1 text-[12.5px] text-ink-400">
              A video becomes the target; a photo fills whichever slot is empty.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Header() {
  return (
    <div className="mb-4 flex items-center gap-2.5 lg:mb-5">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-600/15 ring-1 ring-accent-600/25">
        <IconSparkles className="h-4 w-4 text-accent-400" />
      </span>
      <div className="min-w-0">
        <h1 className="text-[13.5px] font-semibold leading-tight">Morphiqo</h1>
        <p className="text-[10.5px] leading-tight text-ink-500">
          Everything runs on this device
        </p>
      </div>
    </div>
  )
}
