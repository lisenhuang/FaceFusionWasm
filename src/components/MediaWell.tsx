'use client'

/**
 * MediaWell.tsx
 *
 * The drop targets for the source face and the target media.
 *
 * On a phone there is nothing to drop onto, so the same control is simply a
 * large tap target that opens the picker — `capture` is deliberately left off so
 * the camera and the library are both offered.
 */

import { useRef, useState, type ReactNode } from 'react'

import { Button, IconClose, cx } from './ui'

interface MediaWellProps {
  title: string
  hint: string
  accept: string
  filled: boolean
  caption?: string | null
  captionTone?: 'normal' | 'warn'
  icon: ReactNode
  preview?: ReactNode
  onChoose(file: File): void
  onClear(): void
}

export function MediaWell({
  title,
  hint,
  accept,
  filled,
  caption,
  captionTone = 'normal',
  icon,
  preview,
  onChoose,
  onClear,
}: MediaWellProps) {
  const input = useRef<HTMLInputElement>(null)
  const [targeted, setTargeted] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
          {title}
        </h3>
        {filled ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={`Remove ${title.toLowerCase()}`}
            title="Remove"
            onClick={onClear}
          >
            <IconClose />
          </Button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setTargeted(true)
        }}
        onDragLeave={() => setTargeted(false)}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setTargeted(false)
          const file = event.dataTransfer.files?.[0]
          if (file) onChoose(file)
        }}
        className={cx(
          'relative grid h-28 w-full place-items-center overflow-hidden rounded-xl transition-colors sm:h-[104px]',
          filled ? 'bg-ink-800' : 'bg-ink-800/45 hover:bg-ink-800/70',
          targeted && 'bg-accent-600/15',
        )}
      >
        {filled && preview ? (
          <span className="absolute inset-0">{preview}</span>
        ) : (
          <span className="flex flex-col items-center gap-1.5 px-3 text-center text-ink-400">
            <span className="text-ink-500">{icon}</span>
            <span className="text-[11.5px] leading-tight whitespace-pre-line">{hint}</span>
          </span>
        )}

        <span
          className={cx(
            'pointer-events-none absolute inset-0 rounded-xl ring-1 transition-colors',
            targeted
              ? 'ring-2 ring-accent-500'
              : filled
                ? 'ring-ink-600'
                : 'ring-ink-700',
          )}
          style={filled || targeted ? undefined : { borderStyle: 'dashed' }}
        />
      </button>

      {caption ? (
        <p
          className={cx(
            'text-[11.5px] leading-snug',
            captionTone === 'warn' ? 'text-warn-500' : 'text-ink-400',
          )}
        >
          {caption}
        </p>
      ) : null}

      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onChoose(file)
          // Clearing lets the same file be chosen twice in a row, which is
          // otherwise a silent no-op.
          event.target.value = ''
        }}
      />
    </div>
  )
}
