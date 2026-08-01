/**
 * landmarker.ts
 *
 * 2DFAN-4 refines the detector's five coarse key points into 68 landmarks.
 * Re-deriving the five points from those 68 gives a noticeably steadier
 * alignment across a video than the detector's own output, which jitters.
 *
 * The crop is a pure scale-and-translate that puts the face box into a 256×256
 * frame at a fixed 195px working size.
 */

import {
  type Point,
  type Rect,
  applyTransform,
  invert,
  translationTransform,
} from './geometry'
import type { RGBAImage } from './image'
import type { ORTModel } from './runtime'
import { engineError } from './types'

export interface LandmarkResult {
  landmarks68: Point[]
  /** 0…1 confidence, derived from peak heatmap response. */
  score: number
}

export const LANDMARKER_INPUT_SIZE = 256
/** The face box is normalised to this many pixels inside the crop. */
const WORKING_SIZE = 195

export class FaceLandmarker {
  private readonly model: ORTModel

  constructor(model: ORTModel) {
    this.model = model
  }

  async landmarks(image: RGBAImage, box: Rect): Promise<LandmarkResult> {
    const extent = Math.max(box.width, box.height)
    const scale = WORKING_SIZE / Math.max(extent, 1)

    // Centre the box in the crop: the reference computes the translation from
    // the summed box edges, which is the midpoint doubled.
    const translation = {
      x: (LANDMARKER_INPUT_SIZE - (box.x + (box.x + box.width)) * scale) * 0.5,
      y: (LANDMARKER_INPUT_SIZE - (box.y + (box.y + box.height)) * scale) * 0.5,
    }
    const transform = translationTransform(scale, translation)

    const crop = image.warped(transform, LANDMARKER_INPUT_SIZE, LANDMARKER_INPUT_SIZE)
    const input = crop.tensorCHW('bgr')

    const outputs = await this.model.run({ [this.model.inputNames[0]]: input })

    // Two outputs: the landmark grid and the heatmaps behind it.
    const landmarkTensor = outputs.landmarks ?? outputs[this.model.outputNames[0]]
    if (!landmarkTensor) {
      throw engineError('inferenceFailed', 'landmarker produced no output')
    }

    // [1, 68, 3] where x and y live on a 64-unit grid.
    const stride = landmarkTensor.shape[landmarkTensor.shape.length - 1] ?? 3
    const pointCount = Math.min(68, Math.floor(landmarkTensor.data.length / stride))
    const gridToCrop = LANDMARKER_INPUT_SIZE / 64

    const inverse = invert(transform)
    const points: Point[] = []
    for (let i = 0; i < pointCount; i += 1) {
      points.push(
        applyTransform(inverse, {
          x: landmarkTensor.data[i * stride] * gridToCrop,
          y: landmarkTensor.data[i * stride + 1] * gridToCrop,
        }),
      )
    }

    let score = 1
    const heatmaps = outputs.heatmaps
    if (heatmaps && heatmaps.shape.length === 4) {
      const count = heatmaps.shape[1]
      const cells = heatmaps.shape[2] * heatmaps.shape[3]
      let total = 0
      for (let k = 0; k < count; k += 1) {
        let peak = -Infinity
        const base = k * cells
        for (let c = 0; c < cells; c += 1) {
          const value = heatmaps.data[base + c]
          if (value > peak) peak = value
        }
        total += peak
      }
      // The reference maps a mean peak of 0.9 to full confidence.
      score = Math.min(Math.max(total / count / 0.9, 0), 1)
    }

    return { landmarks68: points, score }
  }
}
