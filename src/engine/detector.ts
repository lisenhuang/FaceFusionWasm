/**
 * detector.ts
 *
 * YOLO-face detection. The graph takes a 640×640 canvas and emits, for each of
 * 8400 anchors, a box, a confidence and five key points:
 *
 *     output[1, 20, 8400] -> transposed to 8400 rows of
 *     [cx, cy, w, h, score, (x, y, conf) × 5]
 *
 * The frame is downscaled to fit 640×640 and pasted at the canvas origin rather
 * than letterboxed, so undoing it is a single uniform scale.
 */

import type { Point, Rect } from './geometry'
import type { RGBAImage } from './image'
import type { ORTModel } from './runtime'
import { engineError } from './types'

export interface FaceObservation {
  box: Rect
  score: number
  /** Five points in original-frame pixels. */
  landmarks: Point[]
}

export const DETECTOR_INPUT_SIZE = 640

export class FaceDetector {
  private readonly model: ORTModel

  constructor(model: ORTModel) {
    this.model = model
  }

  async detect(image: RGBAImage, scoreThreshold: number): Promise<FaceObservation[]> {
    const { image: restricted } = image.restricted(DETECTOR_INPUT_SIZE)

    // `restricted` never upscales, so recover the exact ratio from the
    // dimensions rather than trusting a float scale factor.
    const ratioX = image.width / restricted.width
    const ratioY = image.height / restricted.height

    // The reference pipeline feeds this model BGR, not RGB.
    const input = restricted.tensorCHW('bgr', 0, 1, {
      width: DETECTOR_INPUT_SIZE,
      height: DETECTOR_INPUT_SIZE,
    })

    const outputs = await this.model.run({ [this.model.inputNames[0]]: input })
    const detection = outputs[this.model.outputNames[0]]
    if (!detection) throw engineError('inferenceFailed', 'detector produced no output')

    // Shape is [1, 20, 8400]: attribute-major, so the stride between rows is
    // the anchor count.
    const dims = detection.shape
    if (dims.length !== 3 || dims[1] < 15) {
      throw engineError('inferenceFailed', `unexpected detector shape ${dims.join('×')}`)
    }
    const attributes = dims[1]
    const anchors = dims[2]
    const values = detection.data

    const observations: FaceObservation[] = []

    for (let anchor = 0; anchor < anchors; anchor += 1) {
      const score = values[4 * anchors + anchor]
      if (score <= scoreThreshold) continue

      const cx = values[anchor]
      const cy = values[anchors + anchor]
      const w = values[2 * anchors + anchor]
      const h = values[3 * anchors + anchor]

      const box: Rect = {
        x: (cx - w / 2) * ratioX,
        y: (cy - h / 2) * ratioY,
        width: w * ratioX,
        height: h * ratioY,
      }

      // Key points start at attribute 5, three values each.
      const landmarks: Point[] = []
      for (let k = 0; k < 5; k += 1) {
        const base = 5 + k * 3
        if (base + 1 >= attributes) break
        landmarks.push({
          x: values[base * anchors + anchor] * ratioX,
          y: values[(base + 1) * anchors + anchor] * ratioY,
        })
      }
      if (landmarks.length !== 5) continue

      observations.push({ box, score, landmarks })
    }

    return nonMaximumSuppression(observations, 0.4)
  }
}

/** Greedy NMS. The detector fires on several neighbouring anchors per face. */
export function nonMaximumSuppression(
  faces: readonly FaceObservation[],
  iouThreshold: number,
): FaceObservation[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score)
  const kept: FaceObservation[] = []

  for (const candidate of sorted) {
    let overlaps = false
    for (const existing of kept) {
      if (intersectionOverUnion(candidate.box, existing.box) > iouThreshold) {
        overlaps = true
        break
      }
    }
    if (!overlaps) kept.push(candidate)
  }
  return kept
}

function intersectionOverUnion(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const intersectionWidth = x2 - x1
  const intersectionHeight = y2 - y1
  if (intersectionWidth <= 0 || intersectionHeight <= 0) return 0
  const intersectionArea = intersectionWidth * intersectionHeight
  const unionArea = a.width * a.height + b.width * b.height - intersectionArea
  return unionArea > 0 ? intersectionArea / unionArea : 0
}
