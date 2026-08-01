'use client'

/**
 * ActionBar.tsx
 *
 * The bar along the bottom: readiness, progress, or the finished file.
 *
 * "Export" means something different here than on the desktop. There is no save
 * panel and no file system to write to, so the result is handed over as a
 * download — which is also the moment it first exists as a file at all.
 */

import { duration } from '@/lib/format'
import { canRender, useStore } from '@/lib/store'
import {
  Button,
  IconCheck,
  IconClose,
  IconDownload,
  IconWarning,
  ProgressBar,
} from './ui'

export function ActionBar() {
  const phase = useStore((state) => state.phase)

  return (
    <footer
      className="ff-panel border-t border-ink-800 px-3 py-2.5 sm:px-4"
      style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
    >
      {phase.kind === 'rendering' ? (
        <RenderingBar />
      ) : phase.kind === 'finished' ? (
        <FinishedBar url={phase.url} name={phase.name} notes={phase.notes} />
      ) : phase.kind === 'failed' ? (
        <FailedBar message={phase.message} />
      ) : (
        <IdleBar />
      )}
    </footer>
  )
}

function IdleBar() {
  const statusMessage = useStore((state) => state.statusMessage)
  const isPhoto = useStore((state) => state.target?.kind === 'image')
  const ready = useStore(canRender)
  const exportResult = useStore((state) => state.exportResult)
  const hint = useStore(readinessHint)

  return (
    <div className="flex items-center gap-3">
      <p className="min-w-0 flex-1 truncate text-[12.5px] text-ink-400">
        {statusMessage ?? hint}
      </p>
      <Button
        variant="primary"
        size="lg"
        disabled={!ready}
        onClick={() => void exportResult()}
      >
        <IconDownload />
        {isPhoto ? 'Export photo' : 'Export video'}
      </Button>
    </div>
  )
}

function RenderingBar() {
  const progress = useStore((state) => state.progress)
  const isPhoto = useStore((state) => state.target?.kind === 'image')
  const cancel = useStore((state) => state.cancelExport)

  const remaining =
    progress && progress.framesPerSecond > 0.01 && progress.totalFrames > progress.framesWritten
      ? (progress.totalFrames - progress.framesWritten) / progress.framesPerSecond
      : null

  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {isPhoto ? (
          <>
            <ProgressBar indeterminate />
            <p className="text-[11.5px] text-ink-400">Rendering the photo…</p>
          </>
        ) : (
          <>
            <ProgressBar
              fraction={
                progress && progress.totalFrames > 0
                  ? progress.framesWritten / progress.totalFrames
                  : 0
              }
            />
            <p className="flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-ink-400">
              {progress ? (
                <>
                  <span>
                    {progress.framesWritten} / {progress.totalFrames} frames
                  </span>
                  {progress.framesPerSecond > 0 ? (
                    <span>{progress.framesPerSecond.toFixed(1)} fps</span>
                  ) : null}
                  {remaining !== null ? <span>{duration(remaining)} left</span> : null}
                </>
              ) : (
                <span>Starting…</span>
              )}
            </p>
          </>
        )}
      </div>
      <Button size="lg" disabled={isPhoto} onClick={cancel}>
        Cancel
      </Button>
    </div>
  )
}

function FinishedBar({
  url,
  name,
  notes,
}: {
  url: string
  name: string
  notes: string[]
}) {
  const dismiss = useStore((state) => state.dismissResult)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <IconCheck className="h-5 w-5 shrink-0 text-good-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Export complete</p>
          <p className="truncate text-[11.5px] text-ink-400">{name}</p>
        </div>
        <a
          href={url}
          download={name}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent-600 px-5 text-[14px] font-medium text-white transition-colors hover:bg-accent-500"
        >
          <IconDownload />
          Save
        </a>
        <Button
          variant="ghost"
          className="h-9 w-9 shrink-0 p-0"
          aria-label="Dismiss"
          onClick={dismiss}
        >
          <IconClose />
        </Button>
      </div>
      {notes.map((note) => (
        <p key={note} className="text-[11.5px] text-warn-500">
          {note}
        </p>
      ))}
    </div>
  )
}

function FailedBar({ message }: { message: string }) {
  const dismiss = useStore((state) => state.dismissResult)
  return (
    <div className="flex items-center gap-3">
      <IconWarning className="h-5 w-5 shrink-0 text-warn-500" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">{message}</p>
      <Button onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

function readinessHint(state: ReturnType<typeof useStore.getState>): string {
  if (!state.sourceFace && !state.target) return 'Add a face and a video or photo to begin.'
  if (!state.sourceFace) return 'Add a source face.'
  if (!state.target) return 'Add a target video or photo.'
  if (state.faceSelection.kind === 'reference' && state.checkedPeople.length === 0) {
    return state.people.length === 0
      ? 'Find the faces in the target, then tick the ones to replace.'
      : 'Tick at least one face to replace.'
  }
  return 'Ready to export.'
}
