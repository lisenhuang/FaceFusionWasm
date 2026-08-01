'use client'

/**
 * Scrubber.tsx
 *
 * The timeline and the before/after toggle.
 *
 * A photo has no timeline, but it still earns the comparison toggle — which is
 * why that button does not live inside the slider row.
 */

import { timecode } from '@/lib/format'
import { useStore } from '@/lib/store'
import { Button, IconEye, IconEyeOff, Slider } from './ui'

export function Scrubber() {
  const target = useStore((state) => state.target)
  const previewTime = useStore((state) => state.previewTime)
  const setPreviewTime = useStore((state) => state.setPreviewTime)
  const previewResult = useStore((state) => state.previewResult)
  const showsOriginal = useStore((state) => state.showsOriginal)
  const toggleOriginal = useStore((state) => state.toggleOriginal)
  const rendering = useStore((state) => state.phase.kind === 'rendering')

  const timeline = target?.kind === 'video' && target.durationSeconds > 0 ? target : null
  const canCompare = previewResult !== null

  if (!timeline && !canCompare) return null

  return (
    <div className="flex items-center gap-3 px-3 pb-2 sm:px-4">
      {timeline ? (
        <>
          <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-ink-400">
            {timecode(previewTime)}
          </span>
          <Slider
            aria-label="Preview position"
            value={previewTime}
            min={0}
            max={timeline.durationSeconds}
            step={0.05}
            disabled={rendering}
            onChange={setPreviewTime}
          />
          <span className="w-10 shrink-0 text-[11.5px] tabular-nums text-ink-400">
            {timecode(timeline.durationSeconds)}
          </span>
        </>
      ) : (
        <span className="flex-1" />
      )}

      {canCompare ? (
        <Button
          size="sm"
          onClick={toggleOriginal}
          title="Compare with the untouched frame"
          className="shrink-0"
        >
          {showsOriginal ? <IconEyeOff /> : <IconEye />}
          <span className="hidden sm:inline">
            {showsOriginal ? 'Showing original' : 'Showing result'}
          </span>
        </Button>
      ) : null}
    </div>
  )
}
