'use client'

/**
 * PreviewCanvas.tsx
 *
 * Shows the current frame, the faces the engine can see, and lets the user tap
 * one to choose which face gets replaced.
 *
 * The frame is painted onto a canvas at its own pixel size and fitted into the
 * available box with `object-fit: contain`. The face overlay is an SVG pinned to
 * the same box, fitted the same way — `xMidYMid meet` is `contain` under another
 * name — so the two agree without either of them knowing the other's numbers.
 *
 * A tap is mapped back through that same fit, which is the macOS canvas's
 * `fittedRect` written in the other direction.
 */

import { useEffect, useMemo, useRef } from 'react'

import { useStore, selectedFaceIndices } from '@/lib/store'
import { IconFilm, Spinner } from './ui'

export function PreviewCanvas() {
  const previewFrame = useStore((state) => state.previewFrame)
  const previewResult = useStore((state) => state.previewResult)
  const showsOriginal = useStore((state) => state.showsOriginal)
  const previewFaces = useStore((state) => state.previewFaces)
  const previewIdentities = useStore((state) => state.previewIdentities)
  const faceSelection = useStore((state) => state.faceSelection)
  const people = useStore((state) => state.people)
  const checkedPeople = useStore((state) => state.checkedPeople)
  const isPreviewing = useStore((state) => state.isPreviewing)
  const selectFaceAt = useStore((state) => state.selectFaceAt)

  // Memoised rather than selected: the answer is a `Set`, and a store selector
  // that builds a new one on every read would never compare equal to the last.
  const selected = useMemo(
    () =>
      selectedFaceIndices({
        faceSelection,
        previewFaces,
        previewIdentities,
        previewFrame,
        people,
        checkedPeople,
      }),
    [faceSelection, previewFaces, previewIdentities, previewFrame, people, checkedPeople],
  )

  const canvas = useRef<HTMLCanvasElement>(null)
  const displayed = showsOriginal ? previewFrame : (previewResult ?? previewFrame)

  useEffect(() => {
    const element = canvas.current
    if (!element || !displayed) return
    if (element.width !== displayed.width || element.height !== displayed.height) {
      element.width = displayed.width
      element.height = displayed.height
    }
    element.getContext('2d')?.putImageData(displayed, 0, 0)
  }, [displayed])

  if (!displayed) {
    return (
      <div className="grid h-full w-full place-items-center rounded-2xl bg-ink-950/70 ring-1 ring-ink-800">
        <div className="flex flex-col items-center gap-2.5 px-6 text-center text-ink-500">
          <IconFilm className="h-8 w-8" />
          <p className="text-[13px]">Choose a video or photo to see it here</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl bg-ink-950/70 ring-1 ring-ink-800">
      {/*
        Both layers are pinned to this box with `absolute inset-0` and fit
        themselves inside it the same way: the canvas with `object-fit: contain`,
        the overlay with the SVG default `xMidYMid meet`. They are the identical
        transform under two names, which is what keeps a face box exactly on the
        face.

        Absolute rather than `height: 100%`, which is the version that does not
        work. A canvas carries its bitmap as intrinsic dimensions, and a
        percentage height that fails to resolve leaves it at its natural size —
        so a 1024² frame becomes a 1024-tall element that the container silently
        crops, which looks exactly like a wrong crop rather than a layout bug.
      */}
      <div className="absolute inset-0">
        <canvas
          ref={canvas}
          className="absolute inset-0 block h-full w-full object-contain"
          onClick={(event) => {
            // The picture occupies a letterboxed sub-rectangle of this element,
            // so the tap has to be mapped through the same fit before it means
            // anything in frame coordinates.
            const bounds = event.currentTarget.getBoundingClientRect()
            const scale = Math.min(
              bounds.width / displayed.width,
              bounds.height / displayed.height,
            )
            const shownWidth = displayed.width * scale
            const shownHeight = displayed.height * scale
            const x = (event.clientX - bounds.left - (bounds.width - shownWidth) / 2) / shownWidth
            const y = (event.clientY - bounds.top - (bounds.height - shownHeight) / 2) / shownHeight
            // A tap on the bars either side of the picture names no face.
            if (x < 0 || x > 1 || y < 0 || y > 1) return
            selectFaceAt({ x, y })
          }}
        />

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${displayed.width} ${displayed.height}`}
          aria-hidden
        >
          {previewFaces.map((face) => {
            const active = selected.has(face.index)
            const width = active ? 2.5 : 1.2
            const box = {
              x: face.box.x,
              y: face.box.y,
              width: face.box.width,
              height: face.box.height,
              rx: Math.max(4, face.box.width * 0.06),
              fill: 'none',
              // `non-scaling-stroke` already reads the width in screen pixels,
              // so it needs no correction for the frame's own scale.
              vectorEffect: 'non-scaling-stroke',
            } as const
            return (
              // Drawn twice: a dark halo first, then the line on top of it. The
              // box lies on the footage, and one stroke cannot be seen against
              // both a bright sky and dark hair — but a light line with a dark
              // edge can, whichever of the two it happens to cross.
              <g key={face.index}>
                <rect
                  {...box}
                  stroke="var(--ff-face-halo)"
                  strokeWidth={width + 2}
                />
                <rect
                  {...box}
                  stroke={active ? 'var(--ff-face-selected)' : 'var(--ff-face-outline)'}
                  strokeWidth={width}
                />
              </g>
            )
          })}
        </svg>
      </div>

      {isPreviewing ? (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-full bg-ink-900/85 px-3 py-1.5 text-[12px] text-ink-200 ring-1 ring-ink-700 backdrop-blur">
          <Spinner className="h-3.5 w-3.5" />
          Previewing…
        </div>
      ) : null}
    </div>
  )
}
