/** Small formatters shared across the interface. */

export function formatBytes(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)} GB`
  if (count >= 1e6) return `${Math.round(count / 1e6)} MB`
  if (count >= 1e3) return `${Math.round(count / 1e3)} kB`
  return `${count} B`
}

/** m:ss, as on the macOS scrubber. */
export function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Adds an hours field only when there are hours, so short clips stay short. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  if (total >= 3600) {
    const hours = Math.floor(total / 3600)
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    return `${hours}:${minutes}:${String(total % 60).padStart(2, '0')}`
  }
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}
