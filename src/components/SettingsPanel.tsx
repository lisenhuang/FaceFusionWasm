'use client'

/**
 * SettingsPanel.tsx
 *
 * The sidebar: the two media wells, the three face modes, and the handful of
 * knobs worth exposing.
 *
 * On a phone this is the same component, stacked under the preview rather than
 * beside it — there is nothing here that needs a wide column.
 */

import {
  MODEL_DISPLAY_NAME,
  type FaceSelection,
} from '@/engine/types'
import { duration } from '@/lib/format'
import { faceMode, isInstalled, isUsable, useStore, type FaceMode } from '@/lib/store'
import { FacePicker } from './FacePicker'
import { MediaWell } from './MediaWell'
import { StoragePanel } from './StoragePanel'
import {
  IconBolt,
  IconFilm,
  IconPerson,
  IconWarning,
  Segmented,
  SectionLabel,
  Slider,
  Spinner,
  Toggle,
  cx,
} from './ui'

export function SettingsPanel() {
  const sourcePreviewURL = useStore((state) => state.sourcePreviewURL)
  const sourceFace = useStore((state) => state.sourceFace)
  const sourceFaceCount = useStore((state) => state.sourceFaceCount)
  const sourceBusy = useStore((state) => state.sourceBusy)
  const sourceName = useStore((state) => state.sourceName)

  const target = useStore((state) => state.target)
  const previewFrame = useStore((state) => state.previewFrame)

  const selection = useStore((state) => state.faceSelection)
  const identityStrength = useStore((state) => state.identityStrength)
  const maskBlur = useStore((state) => state.maskBlur)
  const enhanceFace = useStore((state) => state.enhanceFace)
  const useHEVC = useStore((state) => state.useHEVC)
  const enhancerInstalled = useStore((state) => isInstalled(state, 'gfpgan_1.4'))
  // Installed and loaded are not the same thing once preparation has had to run
  // with a reduced footprint: the file is there, the session is not.
  const enhancerUsable = useStore((state) => isUsable(state, 'gfpgan_1.4'))
  const engineReady = useStore((state) => state.engine.kind === 'ready')

  const chooseSource = useStore((state) => state.chooseSource)
  const clearSource = useStore((state) => state.clearSource)
  const chooseTarget = useStore((state) => state.chooseTarget)
  const clearTarget = useStore((state) => state.clearTarget)
  const setFaceMode = useStore((state) => state.setFaceMode)
  const setIdentityStrength = useStore((state) => state.setIdentityStrength)
  const setMaskBlur = useStore((state) => state.setMaskBlur)
  const setEnhanceFace = useStore((state) => state.setEnhanceFace)
  const setUseHEVC = useStore((state) => state.setUseHEVC)
  const refreshPreview = useStore((state) => state.refreshPreview)

  const mode = faceMode(selection)
  const isPhoto = target?.kind === 'image'

  return (
    <div className="flex flex-col gap-5">
      <MediaWell
        title="Source face"
        hint={'Drop a photo\nor tap to choose'}
        accept="image/*"
        filled={Boolean(sourcePreviewURL)}
        icon={<IconPerson className="h-6 w-6" />}
        caption={sourceCaption({
          sourceName,
          sourceFace,
          sourceFaceCount,
          sourceBusy,
          engineReady,
        })}
        captionTone={
          sourceName && !sourceFace && !sourceBusy && engineReady ? 'warn' : 'normal'
        }
        preview={
          sourcePreviewURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sourcePreviewURL} alt="" className="h-full w-full object-cover" />
          ) : null
        }
        onChoose={(file) => void chooseSource(file)}
        onClear={clearSource}
      />

      <MediaWell
        title="Target"
        hint={'Drop a video or photo\nor tap to choose'}
        accept="video/*,image/*"
        filled={Boolean(target)}
        icon={<IconFilm className="h-6 w-6" />}
        caption={targetCaption(target)}
        preview={previewFrame ? <FramePreview frame={previewFrame} /> : null}
        onChoose={(file) => void chooseTarget(file)}
        onClear={clearTarget}
      />

      <hr className="border-ink-800" />

      <div className="flex flex-col gap-4">
        <SectionLabel>Settings</SectionLabel>

        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] text-ink-200">Which face</span>
          <Segmented<FaceMode>
            value={mode}
            onChange={setFaceMode}
            options={[
              { value: 'everyFace', label: 'Every' },
              { value: 'oneFace', label: 'One' },
              { value: 'chosen', label: 'Choose' },
            ]}
          />
          <p className="text-[11px] leading-relaxed text-ink-500">{faceModeHint(mode, isPhoto)}</p>
          {mode === 'chosen' ? (
            <div className="pt-1">
              <FacePicker />
            </div>
          ) : null}
        </div>

        <LabelledSlider
          label="Resemblance"
          value={identityStrength}
          display={`${Math.round(identityStrength * 100)}%`}
          onChange={setIdentityStrength}
          onCommit={() => void refreshPreview()}
          hint="Higher keeps more of the source face; lower blends toward the original."
        />

        <LabelledSlider
          label="Edge softness"
          value={maskBlur}
          display={`${Math.round(maskBlur * 100)}%`}
          onChange={setMaskBlur}
          onCommit={() => void refreshPreview()}
        />

        <Toggle
          checked={enhanceFace && enhancerUsable}
          disabled={!enhancerUsable}
          onChange={setEnhanceFace}
          title="Enhance detail"
          hint={
            enhancerUsable
              ? 'Sharper skin and eyes. Slower.'
              : enhancerInstalled
                ? `The ${MODEL_DISPLAY_NAME['gfpgan_1.4']} is installed but not loaded: this device did not have the memory for it. Removing it under Storage frees the space.`
                : `Needs the ${MODEL_DISPLAY_NAME['gfpgan_1.4']}, which is not installed. Add it under Storage.`
          }
        />

        {/* Codec choice is meaningless for a photo, which is always written as a PNG. */}
        {!isPhoto ? (
          <Toggle
            checked={useHEVC}
            onChange={setUseHEVC}
            title="Export as HEVC"
            hint={useHEVC ? 'Smaller files.' : 'H.264 plays anywhere.'}
          />
        ) : null}
      </div>

      <hr className="border-ink-800" />

      <StoragePanel />

      <EngineBadge />
    </div>
  )
}

// MARK: - Pieces

function LabelledSlider({
  label,
  value,
  display,
  hint,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  display: string
  hint?: string
  onChange(value: number): void
  onCommit(): void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] text-ink-200">{label}</span>
        <span className="text-[11.5px] tabular-nums text-ink-400">{display}</span>
      </div>
      <Slider
        aria-label={label}
        value={value}
        onChange={onChange}
        onCommit={onCommit}
      />
      {hint ? <p className="text-[11px] leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  )
}

function FramePreview({ frame }: { frame: ImageData }) {
  return (
    <canvas
      className="h-full w-full object-cover"
      width={frame.width}
      height={frame.height}
      ref={(element) => {
        element?.getContext('2d')?.putImageData(frame, 0, 0)
      }}
    />
  )
}

function EngineBadge() {
  const engine = useStore((state) => state.engine)
  // A deletion parks the engine in `preparing` so nothing dispatches work at a
  // pipeline that is being torn down. That is true, but "Starting engine…" is
  // not what is happening, and this is the one place that says what is.
  const libraryBusy = useStore((state) => state.libraryBusy)

  if (libraryBusy) {
    return (
      <div className="flex items-center gap-2 text-[11.5px] text-ink-400">
        <Spinner className="h-3.5 w-3.5" />
        <span>Reclaiming space…</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-[11.5px] text-ink-400">
      {engine.kind === 'ready' ? (
        <>
          <IconBolt
            className={cx('h-3.5 w-3.5', engine.preparation.usingGPU ? 'text-good-500' : 'text-ink-400')}
          />
          <span>{engine.preparation.executionProvider}</span>
        </>
      ) : engine.kind === 'preparing' ? (
        <>
          <Spinner className="h-3.5 w-3.5" />
          <span>Starting engine…</span>
        </>
      ) : engine.kind === 'failed' ? (
        <>
          <IconWarning className="h-3.5 w-3.5 shrink-0 text-warn-500" />
          <span className="line-clamp-2">{engine.message}</span>
        </>
      ) : (
        <span>Engine idle</span>
      )}
    </div>
  )
}

// MARK: - Captions

function sourceCaption({
  sourceName,
  sourceFace,
  sourceFaceCount,
  sourceBusy,
  engineReady,
}: {
  sourceName: string | null
  sourceFace: unknown
  sourceFaceCount: number
  sourceBusy: boolean
  engineReady: boolean
}): string | null {
  if (!sourceName) return null
  if (sourceBusy) return 'Encoding…'
  // A face can be chosen before the engine has finished loading its models, and
  // "no face found" would be a flatly wrong thing to say about a photo nothing
  // has looked at yet. The encoding is re-run the moment the engine is up.
  if (!engineReady) return 'Waiting for the engine…'
  if (!sourceFace) {
    return sourceFaceCount === 0
      ? 'No face found — try a clearer, front-facing photo.'
      : 'Encoding…'
  }
  return sourceFaceCount > 1 ? `Using the largest of ${sourceFaceCount} faces.` : 'Face ready.'
}

function targetCaption(target: ReturnType<typeof useStore.getState>['target']): string | null {
  if (!target) return null
  const size = `${Math.round(target.width)}×${Math.round(target.height)}`
  if (target.kind === 'video') {
    return `${size} · ${duration(target.durationSeconds)} · ${target.codecDescription}`
  }
  return `${size} · ${target.format || 'Photo'}`
}

function faceModeHint(mode: FaceMode, isPhoto: boolean): string {
  switch (mode) {
    case 'everyFace':
      return 'Replaces every face in the frame.'
    case 'oneFace':
      return 'Replaces one face. Tap a different face in the preview to switch.'
    case 'chosen':
      return isPhoto
        ? 'Replaces only the faces you tick.'
        : 'Replaces only the people you tick, wherever they appear in the video.'
  }
}

export type { FaceSelection }
