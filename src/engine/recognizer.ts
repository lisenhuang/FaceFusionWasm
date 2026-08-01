/**
 * recognizer.ts
 *
 * ArcFace turns an aligned face into a 512-dimensional identity vector. That
 * vector — not the source pixels — is what the swapper is conditioned on.
 */

import { type Point, WarpTemplate, alignmentTransform } from './geometry'
import type { RGBAImage } from './image'
import type { ORTModel } from './runtime'
import { engineError } from './types'

export interface FaceEmbedding {
  /** Raw network output. The swapper's projection needs this unnormalised. */
  raw: Float32Array
  /** L2-normalised, for identity comparison and blending. */
  normalized: Float32Array
}

export const RECOGNIZER_INPUT_SIZE = 112

export class FaceRecognizer {
  private readonly model: ORTModel

  constructor(model: ORTModel) {
    this.model = model
  }

  async embedding(image: RGBAImage, landmarks: readonly Point[]): Promise<FaceEmbedding> {
    const transform = alignmentTransform(
      landmarks,
      WarpTemplate.arcface112v2,
      RECOGNIZER_INPUT_SIZE,
    )
    const crop = image.warped(transform, RECOGNIZER_INPUT_SIZE, RECOGNIZER_INPUT_SIZE)

    // The reference computes `crop / 127.5 - 1`, i.e. normalise to 0…1 then
    // centre on 0.5 with a 0.5 spread.
    const input = crop.tensorCHW('rgb', 0.5, 0.5)

    const outputs = await this.model.run({ [this.model.inputNames[0]]: input })
    const tensor = outputs[this.model.outputNames[0]]
    if (!tensor) throw engineError('inferenceFailed', 'recognizer produced no output')

    const raw = tensor.data
    let magnitude = 0
    for (let i = 0; i < raw.length; i += 1) magnitude += raw[i] * raw[i]
    magnitude = Math.sqrt(magnitude)
    if (!(magnitude > Number.EPSILON)) {
      throw engineError('inferenceFailed', 'degenerate identity embedding')
    }

    const normalized = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) normalized[i] = raw[i] / magnitude
    return { raw, normalized }
  }
}
