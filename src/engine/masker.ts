/**
 * masker.ts
 *
 * The swapper returns a hard-edged square. Pasting that back as-is leaves a
 * visible seam, so the crop is composited through a feathered mask that falls
 * off before the crop boundary.
 */

import { FloatMask } from './image'

/** Inset percentages applied before feathering. */
export interface MaskPadding {
  top: number
  right: number
  bottom: number
  left: number
}

const noPadding: MaskPadding = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * The mask depends only on its parameters, not on image content, so it is built
 * once and reused. This matters: the enhancer's 512px mask at the default blur
 * needs a ~150-tap separable Gaussian, which is far too expensive to redo on
 * every frame of a video.
 */
const cache = new Map<string, FloatMask>()

/**
 * A soft-edged rectangular mask covering the crop.
 *
 * @param blur 0…1. Scaled against the crop size to give the feather radius,
 *   matching the reference's `face_mask_blur`.
 */
export function boxMask(size: number, blur: number, padding: MaskPadding = noPadding) {
  // Blur is quantised so slider drags do not thrash the cache.
  const key = `${size}:${Math.round(blur * 200)}:${padding.top},${padding.right},${padding.bottom},${padding.left}`
  const cached = cache.get(key)
  if (cached) return cached

  const mask = build(size, blur, padding)
  // Bounded: only a handful of (size, blur) pairs ever occur.
  if (cache.size > 32) cache.clear()
  cache.set(key, mask)
  return mask
}

function build(size: number, blur: number, padding: MaskPadding): FloatMask {
  const blurAmount = Math.floor(size * 0.5 * blur)
  // Always keep at least a one-pixel border so the edge never lands exactly on
  // the crop boundary.
  const blurArea = Math.max(Math.floor(blurAmount / 2), 1)

  const mask = new FloatMask(size, size, 1)

  const top = Math.max(blurArea, Math.floor((size * padding.top) / 100))
  const bottom = Math.max(blurArea, Math.floor((size * padding.bottom) / 100))
  const left = Math.max(blurArea, Math.floor((size * padding.left) / 100))
  const right = Math.max(blurArea, Math.floor((size * padding.right) / 100))

  for (let y = 0; y < size; y += 1) {
    const inRow = y >= top && y < size - bottom
    for (let x = 0; x < size; x += 1) {
      const inside = inRow && x >= left && x < size - right
      if (!inside) mask.values[y * size + x] = 0
    }
  }

  if (blurAmount <= 0) return mask
  return mask.blurred(blurAmount * 0.25)
}
