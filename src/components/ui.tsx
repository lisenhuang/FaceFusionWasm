'use client'

/**
 * ui.tsx
 *
 * The handful of controls the app repeats. Small enough to keep in one file, and
 * worth keeping together: a slider that behaves differently in two places is
 * more confusing than one that is slightly wrong in both.
 */

import type { ReactNode } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// MARK: - Slider

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  'aria-label': string
  onChange(value: number): void
  /** Fires when the drag ends — the moment worth re-rendering a preview for. */
  onCommit?(value: number): void
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
  onChange,
  onCommit,
  ...rest
}: SliderProps) {
  const fill = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="ff-slider"
      style={{ ['--ff-fill' as string]: `${fill}%` }}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      // Pointer for mouse and touch, keyup for the arrow keys: between them,
      // every way of finishing a change is covered exactly once.
      onPointerUp={() => onCommit?.(value)}
      onKeyUp={() => onCommit?.(value)}
      {...rest}
    />
  )
}

// MARK: - Segmented control

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange(value: T): void
  disabled?: boolean
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      className={cx(
        'grid gap-1 rounded-lg bg-ink-800/80 p-1 ring-1 ring-ink-700',
        disabled && 'pointer-events-none opacity-50',
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(option.value)}
            className={cx(
              'rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors',
              active
                ? 'bg-accent-600 text-white shadow-sm'
                : 'text-ink-300 hover:bg-ink-700/70 hover:text-ink-100',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// MARK: - Toggle

interface ToggleProps {
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
  title: string
  hint?: ReactNode
}

export function Toggle({ checked, disabled, onChange, title, hint }: ToggleProps) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3',
        disabled && 'cursor-default opacity-50',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent-600' : 'bg-ink-600',
        )}
      >
        <span
          className={cx(
            'block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-100">{title}</span>
        {hint ? <span className="block text-[11px] text-ink-400">{hint}</span> : null}
      </span>
    </label>
  )
}

// MARK: - Buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-600 text-white hover:bg-accent-500 active:bg-accent-600 disabled:bg-ink-700 disabled:text-ink-400',
  secondary:
    'bg-ink-700/80 text-ink-100 ring-1 ring-ink-600 hover:bg-ink-600/80 disabled:text-ink-500',
  ghost: 'text-ink-300 hover:bg-ink-700/60 hover:text-ink-100',
  link: 'text-accent-300 hover:text-accent-200 underline-offset-2 hover:underline px-0',
}

const SIZES = {
  sm: 'h-7 px-2.5 text-[12px] rounded-md gap-1.5',
  md: 'h-9 px-3.5 text-[13px] rounded-lg gap-2',
  lg: 'h-11 px-5 text-[14px] rounded-xl gap-2 font-medium',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        variant === 'link' && 'h-auto p-0',
        className,
      )}
      {...rest}
    />
  )
}

// MARK: - Progress

export function ProgressBar({
  fraction,
  indeterminate,
}: {
  fraction?: number
  indeterminate?: boolean
}) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      {indeterminate ? (
        <div className="h-full w-1/3 animate-[ff-slide_1.2s_ease-in-out_infinite] rounded-full bg-accent-500" />
      ) : (
        <div
          className="h-full rounded-full bg-accent-500 transition-[width] duration-200"
          style={{ width: `${Math.min(100, Math.max(0, (fraction ?? 0) * 100))}%` }}
        />
      )}
      <style>{`@keyframes ff-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

// MARK: - Section heading

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {children}
    </h2>
  )
}

// MARK: - Icons
//
// Hand-rolled rather than a dependency: the app uses nine of them, and a full
// icon package would be larger than the entire UI bundle.

type IconProps = { className?: string }

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function IconPerson({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  )
}

export function IconFilm({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9.5h18M3 14.5h18M8 5v14M16 5v14" />
    </svg>
  )
}

export function IconSparkles({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9 12 3.5Z" />
      <path d="M18.5 4v3M20 5.5h-3M5.5 16v2.5M6.75 17.25h-2.5" />
    </svg>
  )
}

export function IconClose({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

export function IconCheck({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  )
}

export function IconDownload({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" />
    </svg>
  )
}

export function IconEye({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  )
}

export function IconEyeOff({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M4 4.5 20 19.5M9.6 6.1A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.2 8.4A17.3 17.3 0 0 0 2.5 12S6 18.5 12 18.5c1 0 1.9-.2 2.8-.5" />
      <path d="M10.3 10.4a2.75 2.75 0 0 0 3.5 3.7" />
    </svg>
  )
}

export function IconWarning({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4M12 16.75v.5" />
    </svg>
  )
}

export function IconBolt({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M13 3 5.5 13.5H11l-.5 7.5L18.5 10.5H13L13 3Z" />
    </svg>
  )
}

export function IconShield({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <path d="M12 3.5 19.5 6v6c0 4.2-3.1 7.6-7.5 8.5C7.6 19.6 4.5 16.2 4.5 12V6L12 3.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function IconFaces({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="M18 8.5a2.5 2.5 0 0 1 2.5 2.5v4A2.5 2.5 0 0 1 18 17.5" />
      <circle cx="9" cy="11" r="1.75" />
      <path d="M5.5 16a3.8 3.8 0 0 1 7 0" />
    </svg>
  )
}

// The app renders no outbound links at all: nothing here sends the reader
// anywhere else, and nothing loads from anywhere else.
