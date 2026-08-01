/**
 * image.ts
 *
 * Pixel plumbing: affine warps, tensor packing, mask blurring and blending.
 *
 * Everything works on 32-bit RGBA, which is what `CanvasRenderingContext2D`,
 * `ImageData` and `VideoFrame.copyTo` all hand us. Byte order in memory is
 * R, G, B, A at ascending addresses, so "channel 0" is red.
 *
 * The reference Python pipeline is built on OpenCV and is BGR-first, and the
 * macOS port works in BGRA because that is what IOSurface carries. The channel
 * bookkeeping below is the same logic with the two colour offsets exchanged:
 * `ChannelOrder` names the order values are written into a *tensor*, and the
 * offset table maps that onto the layout in memory.
 */

import { type AffineTransform, concatenate, invert, transformedBounds } from './geometry'

/** Which order the three colour channels are written into a tensor. */
export type ChannelOrder = 'rgb' | 'bgr'

/** Byte offset within an RGBA pixel for tensor channel 0, 1, 2. */
function channelOffsets(order: ChannelOrder): [number, number, number] {
  return order === 'rgb' ? [0, 1, 2] : [2, 1, 0]
}

function clampByte(value: number): number {
  const rounded = Math.round(value)
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded
}

export interface FloatTensor {
  shape: number[]
  data: Float32Array
}

/**
 * A mutable 8-bit RGBA image with tightly packed rows.
 *
 * Deliberately not an `ImageData`: this type travels into a worker, gets
 * transferred back, and is also constructed in Node during verification, where
 * `ImageData` does not exist at all. Its `data` is layout-compatible, so
 * bridging to a canvas is a constructor call and not a copy.
 */
export class RGBAImage {
  readonly width: number
  readonly height: number
  /**
   * Pinned to a plain `ArrayBuffer` rather than `ArrayBufferLike`: these pixels
   * are handed to `ImageData` and to `postMessage` transfer lists, neither of
   * which accepts a `SharedArrayBuffer`.
   */
  readonly data: Uint8ClampedArray<ArrayBuffer>

  constructor(width: number, height: number, data?: Uint8ClampedArray<ArrayBuffer>) {
    this.width = width
    this.height = height
    this.data = data ?? new Uint8ClampedArray(width * height * 4)
  }

  get rowBytes(): number {
    return this.width * 4
  }

  clone(): RGBAImage {
    return new RGBAImage(this.width, this.height, new Uint8ClampedArray(this.data))
  }

  copyContentsInto(destination: RGBAImage): void {
    if (destination.width !== this.width || destination.height !== this.height) {
      throw new Error('copyContentsInto requires identical dimensions')
    }
    destination.data.set(this.data)
  }

  /**
   * Renders this image into a new buffer under `transform`, which maps source
   * coordinates to destination coordinates — the same convention as
   * `cv2.warpAffine`. Sampling is bilinear with edge replication.
   *
   * Face crops are a large downscale — aligning a 1024px portrait to a 112px
   * ArcFace input is a ~7× reduction — and a bare bilinear tap reads only 2×2
   * source pixels, so it aliases badly: neighbouring frames sample different
   * high-frequency detail and the result shimmers. Anything shrinking by more
   * than half is therefore box-reduced first, which is the standard mipmap
   * prefilter.
   *
   * This is the one deliberate divergence from the reference implementation,
   * and it moves agreement with the reference identity vector from 0.956 to
   * 0.966 cosine.
   */
  warped(transform: AffineTransform, outWidth: number, outHeight: number): RGBAImage {
    const scale = Math.sqrt(
      Math.abs(transform.a * transform.d - transform.b * transform.c),
    )

    if (scale > 0 && scale < 0.5) {
      const factor = Math.min(Math.max(Math.floor(1 / scale), 2), 16)
      if (this.width / factor >= 2 && this.height / factor >= 2) {
        const reduced = this.boxReduced(factor)
        // Points now arrive pre-divided by `factor`, so scale back up before
        // applying the original mapping.
        const adjusted = concatenate(
          { a: factor, b: 0, c: 0, d: factor, tx: 0, ty: 0 },
          transform,
        )
        const out = new RGBAImage(outWidth, outHeight)
        reduced.drawWarped(out, adjusted)
        return out
      }
    }

    const out = new RGBAImage(outWidth, outHeight)
    this.drawWarped(out, transform)
    return out
  }

  /** Averages each `factor` × `factor` block into one pixel. */
  boxReduced(factor: number): RGBAImage {
    if (factor < 2) throw new Error('boxReduced needs a factor of at least 2')
    const outWidth = Math.max(1, Math.floor(this.width / factor))
    const outHeight = Math.max(1, Math.floor(this.height / factor))
    const out = new RGBAImage(outWidth, outHeight)
    const inverseArea = 1 / (factor * factor)
    const src = this.data
    const dst = out.data
    const srcStride = this.width * 4

    for (let oy = 0; oy < outHeight; oy += 1) {
      for (let ox = 0; ox < outWidth; ox += 1) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let dy = 0; dy < factor; dy += 1) {
          const sy = Math.min(oy * factor + dy, this.height - 1)
          const rowStart = sy * srcStride
          for (let dx = 0; dx < factor; dx += 1) {
            const sx = Math.min(ox * factor + dx, this.width - 1)
            const index = rowStart + sx * 4
            r += src[index]
            g += src[index + 1]
            b += src[index + 2]
            a += src[index + 3]
          }
        }
        const out4 = (oy * outWidth + ox) * 4
        dst[out4] = clampByte(r * inverseArea)
        dst[out4 + 1] = clampByte(g * inverseArea)
        dst[out4 + 2] = clampByte(b * inverseArea)
        dst[out4 + 3] = clampByte(a * inverseArea)
      }
    }
    return out
  }

  /** As `warped`, but writes into an existing buffer. */
  drawWarped(out: RGBAImage, transform: AffineTransform): void {
    // Sampling is destination-driven, so invert to go dst → src.
    const inverse = invert(transform)
    const srcMaxX = this.width - 1
    const srcMaxY = this.height - 1
    const { a: ia, b: ib, c: ic, d: id, tx: itx, ty: ity } = inverse

    const src = this.data
    const dst = out.data
    const srcStride = this.width * 4
    const outWidth = out.width
    const outHeight = out.height

    for (let y = 0; y < outHeight; y += 1) {
      const fy = y + 0.5
      // Constant part of the source coordinate for this row.
      const baseX = ic * fy + itx - 0.5
      const baseY = id * fy + ity - 0.5
      let out4 = y * outWidth * 4

      for (let x = 0; x < outWidth; x += 1, out4 += 4) {
        const fx = x + 0.5
        // Pixel centres: sample at (x + 0.5) then shift back by half a pixel,
        // matching OpenCV's integer-grid convention.
        let sx = ia * fx + baseX
        let sy = ib * fx + baseY

        sx = sx < 0 ? 0 : sx > srcMaxX ? srcMaxX : sx
        sy = sy < 0 ? 0 : sy > srcMaxY ? srcMaxY : sy

        const x0 = sx | 0
        const y0 = sy | 0
        const x1 = x0 + 1 > srcMaxX ? srcMaxX : x0 + 1
        const y1 = y0 + 1 > srcMaxY ? srcMaxY : y0 + 1
        const wx = sx - x0
        const wy = sy - y0

        const row0 = y0 * srcStride
        const row1 = y1 * srcStride
        const i00 = row0 + x0 * 4
        const i10 = row0 + x1 * 4
        const i01 = row1 + x0 * 4
        const i11 = row1 + x1 * 4

        const w00 = (1 - wx) * (1 - wy)
        const w10 = wx * (1 - wy)
        const w01 = (1 - wx) * wy
        const w11 = wx * wy

        dst[out4] = clampByte(
          src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11,
        )
        dst[out4 + 1] = clampByte(
          src[i00 + 1] * w00 +
            src[i10 + 1] * w10 +
            src[i01 + 1] * w01 +
            src[i11 + 1] * w11,
        )
        dst[out4 + 2] = clampByte(
          src[i00 + 2] * w00 +
            src[i10 + 2] * w10 +
            src[i01 + 2] * w01 +
            src[i11 + 2] * w11,
        )
        dst[out4 + 3] = clampByte(
          src[i00 + 3] * w00 +
            src[i10 + 3] * w10 +
            src[i01 + 3] * w01 +
            src[i11 + 3] * w11,
        )
      }
    }
  }

  /**
   * Proportional downscale so the result fits inside `limit`. Never upscales,
   * mirroring the reference pipeline's `restrict_frame`.
   */
  restricted(limit: number): { image: RGBAImage; scale: number } {
    if (this.width <= limit && this.height <= limit) return { image: this, scale: 1 }
    const scale = Math.min(limit / this.width, limit / this.height)
    const newWidth = Math.max(1, Math.floor(this.width * scale))
    const newHeight = Math.max(1, Math.floor(this.height * scale))
    const transform: AffineTransform = {
      a: newWidth / this.width,
      b: 0,
      c: 0,
      d: newHeight / this.height,
      tx: 0,
      ty: 0,
    }
    return { image: this.warped(transform, newWidth, newHeight), scale }
  }

  /**
   * Packs the image into a `1 × 3 × H × W` float tensor. Each channel becomes
   * `(value / 255 - mean) / standardDeviation`.
   *
   * `padTo` pastes the image at the origin of a larger, zero-filled canvas
   * rather than letterboxing it, so undoing the fit is a single uniform scale.
   */
  tensorCHW(
    order: ChannelOrder,
    mean = 0,
    standardDeviation = 1,
    padTo?: { width: number; height: number },
  ): FloatTensor {
    const outWidth = padTo?.width ?? this.width
    const outHeight = padTo?.height ?? this.height
    const plane = outWidth * outHeight
    const values = new Float32Array(3 * plane)

    const [o0, o1, o2] = channelOffsets(order)
    const invScale = 1 / 255
    const invStd = 1 / standardDeviation
    const copyWidth = Math.min(this.width, outWidth)
    const copyHeight = Math.min(this.height, outHeight)
    const src = this.data
    const srcStride = this.width * 4

    for (let y = 0; y < copyHeight; y += 1) {
      const rowStart = y * srcStride
      let out = y * outWidth
      for (let x = 0; x < copyWidth; x += 1, out += 1) {
        const pixel = rowStart + x * 4
        values[out] = (src[pixel + o0] * invScale - mean) * invStd
        values[plane + out] = (src[pixel + o1] * invScale - mean) * invStd
        values[2 * plane + out] = (src[pixel + o2] * invScale - mean) * invStd
      }
    }
    return { shape: [1, 3, outHeight, outWidth], data: values }
  }

  /**
   * Inverse of `tensorCHW`. Values are denormalised, clamped to 0…1 and written
   * as opaque RGBA.
   */
  static fromTensorCHW(
    tensor: FloatTensor,
    order: ChannelOrder,
    mean = 0,
    standardDeviation = 1,
  ): RGBAImage {
    // Shape is [1, 3, H, W]; tolerate a missing batch dimension.
    const dims = tensor.shape.length === 4 ? tensor.shape.slice(1) : tensor.shape
    const height = dims[1]
    const width = dims[2]
    const plane = width * height
    const image = new RGBAImage(width, height)
    const [o0, o1, o2] = channelOffsets(order)
    const src = tensor.data
    const dst = image.data

    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width
      let pixel = y * width * 4
      for (let x = 0; x < width; x += 1, pixel += 4) {
        const index = rowStart + x
        dst[pixel + o0] = denormalise(src[index], mean, standardDeviation)
        dst[pixel + o1] = denormalise(src[plane + index], mean, standardDeviation)
        dst[pixel + o2] = denormalise(src[2 * plane + index], mean, standardDeviation)
        dst[pixel + 3] = 255
      }
    }
    return image
  }

  /**
   * Warps `patch` back into this image through the inverse of `transform`,
   * blending with `mask` (defined in patch space).
   *
   * Only the region the patch actually lands in is touched, so cost scales with
   * face size rather than frame size.
   */
  pasteBack(
    patch: RGBAImage,
    mask: FloatMask,
    transform: AffineTransform,
    opacity = 1,
  ): void {
    const inverse = invert(transform)
    const bounds = transformedBounds(patch.width, patch.height, inverse)

    const x1 = Math.max(0, Math.floor(bounds.x))
    const y1 = Math.max(0, Math.floor(bounds.y))
    const x2 = Math.min(this.width, Math.ceil(bounds.x + bounds.width))
    const y2 = Math.min(this.height, Math.ceil(bounds.y + bounds.height))
    if (x2 <= x1 || y2 <= y1) return

    const regionWidth = x2 - x1
    const regionHeight = y2 - y1

    // Shift the inverse so it renders directly into the region's origin.
    const pasteTransform: AffineTransform = {
      ...inverse,
      tx: inverse.tx - x1,
      ty: inverse.ty - y1,
    }

    const warpedPatch = patch.warped(pasteTransform, regionWidth, regionHeight)
    const warpedMask = mask.warped(pasteTransform, regionWidth, regionHeight)

    const dst = this.data
    const src = warpedPatch.data
    const alphas = warpedMask.values
    const dstStride = this.width * 4

    for (let ry = 0; ry < regionHeight; ry += 1) {
      const dstRow = (y1 + ry) * dstStride + x1 * 4
      const srcRow = ry * regionWidth * 4
      const maskRow = ry * regionWidth
      for (let rx = 0; rx < regionWidth; rx += 1) {
        let alpha = alphas[maskRow + rx]
        alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha
        alpha *= opacity
        if (alpha <= 0.001) continue
        const di = dstRow + rx * 4
        const si = srcRow + rx * 4
        const inverseAlpha = 1 - alpha
        dst[di] = clampByte(dst[di] * inverseAlpha + src[si] * alpha)
        dst[di + 1] = clampByte(dst[di + 1] * inverseAlpha + src[si + 1] * alpha)
        dst[di + 2] = clampByte(dst[di + 2] * inverseAlpha + src[si + 2] * alpha)
      }
    }
  }

  /** A padded square crop around a face box, for the picker's thumbnails. */
  croppedSquare(box: { x: number; y: number; width: number; height: number }, padding = 0.3) {
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    const side = Math.max(box.width, box.height) * (1 + padding * 2)

    const x1 = Math.max(0, Math.round(centerX - side / 2))
    const y1 = Math.max(0, Math.round(centerY - side / 2))
    const x2 = Math.min(this.width, Math.round(centerX + side / 2))
    const y2 = Math.min(this.height, Math.round(centerY + side / 2))
    const width = x2 - x1
    const height = y2 - y1
    if (width < 16 || height < 16) return null

    const out = new RGBAImage(width, height)
    const srcStride = this.width * 4
    for (let y = 0; y < height; y += 1) {
      const from = (y1 + y) * srcStride + x1 * 4
      out.data.set(this.data.subarray(from, from + width * 4), y * width * 4)
    }
    return out
  }
}

function denormalise(value: number, mean: number, standardDeviation: number): number {
  const v = value * standardDeviation + mean
  return (v < 0 ? 0 : v > 1 ? 1 : v) * 255 + 0.5
}

// MARK: - Masks

/** A single-channel float mask in 0…1. */
export class FloatMask {
  readonly width: number
  readonly height: number
  readonly values: Float32Array

  constructor(width: number, height: number, fill = 0) {
    this.width = width
    this.height = height
    this.values = new Float32Array(width * height)
    if (fill !== 0) this.values.fill(fill)
  }

  /**
   * Separable Gaussian blur. Kernel radius follows OpenCV's rule for a float
   * image when `ksize` is zero: `round(sigma * 4 * 2 + 1) | 1`.
   */
  blurred(sigma: number): FloatMask {
    if (sigma <= 0) return this
    let size = Math.round(sigma * 8 + 1)
    if (size % 2 === 0) size += 1
    const radius = size >> 1
    if (radius < 1) return this

    const kernel = new Float32Array(size)
    const denominator = 2 * sigma * sigma
    let total = 0
    for (let i = 0; i < size; i += 1) {
      const d = i - radius
      const v = Math.exp(-(d * d) / denominator)
      kernel[i] = v
      total += v
    }
    for (let i = 0; i < size; i += 1) kernel[i] /= total

    const { width, height, values } = this
    const horizontal = new Float32Array(values.length)
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        for (let k = 0; k < size; k += 1) {
          let sx = x + k - radius
          sx = sx < 0 ? 0 : sx > width - 1 ? width - 1 : sx
          sum += values[row + sx] * kernel[k]
        }
        horizontal[row + x] = sum
      }
    }

    const out = new FloatMask(width, height)
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        for (let k = 0; k < size; k += 1) {
          let sy = y + k - radius
          sy = sy < 0 ? 0 : sy > height - 1 ? height - 1 : sy
          sum += horizontal[sy * width + x] * kernel[k]
        }
        out.values[row + x] = sum
      }
    }
    return out
  }

  /**
   * Warps the mask with the same conventions as `RGBAImage.drawWarped`,
   * sampling bilinearly and clamping at the edges.
   */
  warped(transform: AffineTransform, outWidth: number, outHeight: number): FloatMask {
    const out = new FloatMask(outWidth, outHeight)
    const inverse = invert(transform)
    const maxX = this.width - 1
    const maxY = this.height - 1
    const { a: ia, b: ib, c: ic, d: id, tx: itx, ty: ity } = inverse
    const values = this.values
    const width = this.width

    for (let y = 0; y < outHeight; y += 1) {
      const fy = y + 0.5
      const baseX = ic * fy + itx - 0.5
      const baseY = id * fy + ity - 0.5
      const outRow = y * outWidth
      for (let x = 0; x < outWidth; x += 1) {
        const fx = x + 0.5
        let sx = ia * fx + baseX
        let sy = ib * fx + baseY
        sx = sx < 0 ? 0 : sx > maxX ? maxX : sx
        sy = sy < 0 ? 0 : sy > maxY ? maxY : sy

        const x0 = sx | 0
        const y0 = sy | 0
        const x1 = x0 + 1 > maxX ? maxX : x0 + 1
        const y1 = y0 + 1 > maxY ? maxY : y0 + 1
        const wx = sx - x0
        const wy = sy - y0

        const row0 = y0 * width
        const row1 = y1 * width
        out.values[outRow + x] =
          values[row0 + x0] * (1 - wx) * (1 - wy) +
          values[row0 + x1] * wx * (1 - wy) +
          values[row1 + x0] * (1 - wx) * wy +
          values[row1 + x1] * wx * wy
      }
    }
    return out
  }
}
