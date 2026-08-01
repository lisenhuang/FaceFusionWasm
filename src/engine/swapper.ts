/**
 * swapper.ts
 *
 * inswapper-128. Two inputs: a 128×128 aligned crop of the *target* face, and a
 * 512-vector describing the *source* identity.
 *
 * The identity vector is not the ArcFace embedding directly. The graph carries a
 * 512×512 projection matrix as its final initializer, and the source vector must
 * be pushed through it first:
 *
 *     source = (embedding · emap) / ‖embedding‖
 *
 * Note the divisor is the magnitude of the *original* embedding, not of the
 * projected result — getting that wrong yields a washed-out, low-identity swap.
 */

import { type AffineTransform, type Point, WarpTemplate, alignmentTransform } from './geometry'
import { RGBAImage } from './image'
import { readLastInitializer } from './onnx-initializer'
import type { ORTModel } from './runtime'
import type { FaceEmbedding } from './recognizer'
import { engineError } from './types'

export const SWAPPER_INPUT_SIZE = 128
export const EMBEDDING_DIMENSION = 512

export class FaceSwapper {
  private readonly model: ORTModel
  /** Row-major 512×512 projection pulled out of the ONNX graph. */
  private readonly projection: Float32Array

  private constructor(model: ORTModel, projection: Float32Array) {
    this.model = model
    this.projection = projection
  }

  /**
   * @param modelBytes the same buffer the session was created from. The
   *   projection is not reachable through the runtime API, so it is read
   *   straight out of the file.
   */
  static create(model: ORTModel, modelBytes: Uint8Array): FaceSwapper {
    const tensor = readLastInitializer(modelBytes)
    const expected = EMBEDDING_DIMENSION * EMBEDDING_DIMENSION
    if (tensor.values.length !== expected) {
      throw engineError(
        'modelLoadFailed',
        `expected a ${EMBEDDING_DIMENSION}² projection, found ${tensor.values.length} values in '${tensor.name}'`,
      )
    }
    return new FaceSwapper(model, tensor.values)
  }

  /**
   * Projects an ArcFace embedding into the swapper's conditioning space.
   *
   * Depends only on the source face, so this runs once when the user picks a
   * portrait rather than once per frame.
   */
  projectSource(source: FaceEmbedding): Float32Array {
    const dimension = EMBEDDING_DIMENSION

    let magnitude = 0
    for (let i = 0; i < source.raw.length; i += 1) magnitude += source.raw[i] * source.raw[i]
    magnitude = Math.max(Math.sqrt(magnitude), Number.EPSILON)
    const inverseMagnitude = 1 / magnitude

    // vector = (embedding · emap) / ‖embedding‖
    const vector = new Float32Array(dimension)
    for (let k = 0; k < dimension; k += 1) {
      const weight = source.raw[k]
      if (weight === 0) continue
      const row = k * dimension
      for (let j = 0; j < dimension; j += 1) vector[j] += weight * this.projection[row + j]
    }
    for (let j = 0; j < dimension; j += 1) vector[j] *= inverseMagnitude
    return vector
  }

  /**
   * How far the conditioning vector is pulled back toward the target's own
   * identity. Mirrors the reference's `face_swapper_weight`, which maps 0…1 onto
   * +0.35…−0.35; 0.5 is the neutral midpoint.
   */
  static blendWeight(identityStrength: number): number {
    return 0.35 - identityStrength * 0.7
  }

  /**
   * True when the target face's own embedding is needed. Skipping this avoids a
   * per-face ArcFace pass on every frame at the neutral setting.
   */
  static needsTargetEmbedding(identityStrength: number): boolean {
    return Math.abs(FaceSwapper.blendWeight(identityStrength)) > 1e-4
  }

  /** Mixes a projected source vector toward a target identity. */
  blend(
    projected: Float32Array,
    target: FaceEmbedding | null,
    identityStrength: number,
  ): Float32Array {
    if (!target) return projected
    const weight = FaceSwapper.blendWeight(identityStrength)
    if (Math.abs(weight) <= 1e-4) return projected

    const vector = new Float32Array(projected.length)
    for (let i = 0; i < projected.length; i += 1) {
      vector[i] = projected[i] * (1 - weight) + target.normalized[i] * weight
    }
    return vector
  }

  /** Runs the swap on one face and returns the 128×128 result. */
  async swap(
    image: RGBAImage,
    landmarks: readonly Point[],
    conditioning: Float32Array,
  ): Promise<{ crop: RGBAImage; transform: AffineTransform }> {
    const transform = alignmentTransform(
      landmarks,
      WarpTemplate.arcface128,
      SWAPPER_INPUT_SIZE,
    )
    const crop = image.warped(transform, SWAPPER_INPUT_SIZE, SWAPPER_INPUT_SIZE)

    // inswapper wants plain 0…1 RGB: no mean subtraction, unit spread.
    const target = crop.tensorCHW('rgb', 0, 1)
    const source = { shape: [1, EMBEDDING_DIMENSION], data: conditioning }

    const outputs = await this.model.run({ target, source })
    const result = outputs[this.model.outputNames[0]]
    if (!result) throw engineError('inferenceFailed', 'swapper produced no output')

    return { crop: RGBAImage.fromTensorCHW(result, 'rgb', 0, 1), transform }
  }
}
