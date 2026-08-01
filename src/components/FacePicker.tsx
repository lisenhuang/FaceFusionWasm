'use client'

/**
 * FacePicker.tsx
 *
 * The list of people in the target, with a checkbox each.
 *
 * The checkboxes are bound to identities rather than to positions, which is the
 * whole reason this mode exists: faces are re-detected independently on every
 * frame, so "the second face" stops naming the same person the moment two people
 * cross.
 */

import { useStore } from '@/lib/store'
import { timecode } from '@/lib/format'
import { Button, IconCheck, IconFaces, IconPerson, ProgressBar, Slider, cx } from './ui'

export function FacePicker() {
  const people = useStore((state) => state.people)
  const checked = useStore((state) => state.checkedPeople)
  const scanProgress = useStore((state) => state.scanProgress)
  const hasScanned = useStore((state) => state.hasScanned)
  const target = useStore((state) => state.target)
  const matchDistance = useStore((state) => state.matchDistance)

  const scan = useStore((state) => state.scanTarget)
  const cancelScan = useStore((state) => state.cancelScan)
  const toggle = useStore((state) => state.togglePerson)
  const checkAll = useStore((state) => state.checkEveryPerson)
  const uncheckAll = useStore((state) => state.uncheckEveryPerson)
  const setMatchDistance = useStore((state) => state.setMatchDistance)
  const applyMatchDistance = useStore((state) => state.applyMatchDistance)

  const isImage = target?.kind === 'image'

  if (scanProgress) {
    const found = scanProgress.peopleFound
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <ProgressBar
            fraction={
              scanProgress.totalFrames > 0
                ? scanProgress.framesScanned / scanProgress.totalFrames
                : 0
            }
          />
          <Button size="sm" onClick={cancelScan}>
            Stop
          </Button>
        </div>
        <p className="text-[11.5px] text-ink-400">
          Frame {scanProgress.framesScanned} of {scanProgress.totalFrames} ·{' '}
          {found === 1 ? '1 person' : `${found} people`} so far
        </p>
      </div>
    )
  }

  if (people.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2.5">
        <p className="text-[11.5px] leading-relaxed text-ink-400">
          {hasScanned
            ? 'No faces found in the target.'
            : isImage
              ? 'Look for the faces in this photo.'
              : 'Look through the video for the people in it, then tick the ones to replace.'}
        </p>
        <Button size="sm" disabled={!target} onClick={scan}>
          <IconFaces />
          {hasScanned ? 'Look again' : 'Find faces'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(60px,1fr))] gap-2">
        {people.map((person) => {
          const isChecked = checked.includes(person.id)
          // Useless for a photo, and for someone in a single sampled frame
          // there is no span to state.
          const span =
            !isImage && person.lastSeen > person.firstSeen + 0.5
              ? `${timecode(person.firstSeen)}–${timecode(person.lastSeen)}`
              : null

          return (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => toggle(person.id)}
                title={isChecked ? 'Will be replaced' : 'Will be left alone'}
                aria-pressed={isChecked}
                className="group flex w-full flex-col items-center gap-1"
              >
                <span
                  className={cx(
                    'relative block aspect-square w-full overflow-hidden rounded-lg bg-ink-800 transition-opacity',
                    isChecked ? 'opacity-100' : 'opacity-55 group-hover:opacity-80',
                  )}
                >
                  {person.thumbnailURL ? (
                    // A data URL from a canvas; next/image would add a loader
                    // for no benefit.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={person.thumbnailURL}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-ink-500">
                      <IconPerson />
                    </span>
                  )}

                  <span
                    className={cx(
                      'pointer-events-none absolute inset-0 rounded-lg ring-inset transition-all',
                      isChecked ? 'ring-2 ring-accent-500' : 'ring-1 ring-ink-600',
                    )}
                  />

                  <span
                    className={cx(
                      'absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full transition-colors',
                      isChecked
                        ? 'bg-accent-500 text-white'
                        : 'bg-ink-950/60 ring-1 ring-ink-500',
                    )}
                  >
                    {isChecked ? <IconCheck className="h-3 w-3" /> : null}
                  </span>
                </span>

                {span ? (
                  <span className="text-[9.5px] tabular-nums text-ink-500">{span}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <p
          className={cx(
            'text-[11.5px]',
            checked.length === 0 ? 'text-warn-500' : 'text-ink-400',
          )}
        >
          {checked.length === 0
            ? 'No one selected — nothing will be replaced.'
            : `Replacing ${checked.length} of ${people.length}.`}
        </p>

        <div className="flex items-center gap-4 text-[11.5px]">
          <Button
            variant="link"
            onClick={checked.length === people.length ? uncheckAll : checkAll}
          >
            {checked.length === people.length ? 'None' : 'All'}
          </Button>
          <Button variant="link" onClick={scan}>
            Look again
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-500">
          Missing someone? Tap their face in the preview to add them.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] text-ink-200">Match strictness</span>
        {/*
          Inverted: the engine works in distance, where larger is looser, but
          "drag right for stricter" is the only direction a slider labelled
          strictness can go.
        */}
        <Slider
          aria-label="Match strictness"
          value={1.1 - matchDistance}
          min={0.3}
          max={0.9}
          step={0.01}
          onChange={(value) => setMatchDistance(1.1 - value)}
          onCommit={() => void applyMatchDistance()}
        />
        <p className="text-[11px] leading-relaxed text-ink-500">
          Lower if someone is missed when they turn away; raise if the wrong person gets
          replaced.
        </p>
      </div>
    </div>
  )
}
