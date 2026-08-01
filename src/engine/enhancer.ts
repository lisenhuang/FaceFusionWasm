/**
 * enhancer.ts
 *
 * GFPGAN restoration. The swapper works at 128×128, so its output is soft on
 * anything but a small face. Running a restorer over the swapped region at
 * 512×512 recovers skin texture and eye detail.
 *
 * This runs on the already-swapped frame, exactly as the reference does, so the
 * restorer sees the composited face rather than the raw crop.
 */

import { type Point, WarpTemplate, alignmentTransform } from './geometry'
import { type FloatTensor, RGBAImage } from './image'
import { boxMask } from './masker'
import type { ORTModel } from './runtime'
import { engineError } from './types'

export const ENHANCER_INPUT_SIZE = 512

export class FaceEnhancer {
  private readonly model: ORTModel

  constructor(model: ORTModel) {
    this.model = model
  }

  /**
   * Enhances one face in place.
   *
   * @param blend 0…1 opacity of the restored face over the original.
   */
  async enhance(
    image: RGBAImage,
    landmarks: readonly Point[],
    maskBlur: number,
    blend: number,
  ): Promise<void> {
    const transform = alignmentTransform(
      landmarks,
      WarpTemplate.ffhq512,
      ENHANCER_INPUT_SIZE,
    )
    const crop = image.warped(transform, ENHANCER_INPUT_SIZE, ENHANCER_INPUT_SIZE)

    const input = crop.tensorCHW('rgb', 0.5, 0.5)

    const inputs: Record<string, FloatTensor> = { [this.model.inputNames[0]]: input }
    // Some restorer graphs take a fidelity weight alongside the image;
    // gfpgan_1.4 does not, so only feed it when the graph asks for it.
    if (this.model.inputNames.length > 1) {
      inputs[this.model.inputNames[1]] = { shape: [1], data: new Float32Array([0.5]) }
    }

    const outputs = await this.model.run(inputs)
    const result = outputs[this.model.outputNames[0]]
    if (!result) throw engineError('inferenceFailed', 'enhancer produced no output')

    const restored = RGBAImage.fromTensorCHW(result, 'rgb', 0.5, 0.5)
    const mask = boxMask(ENHANCER_INPUT_SIZE, maskBlur)

    image.pasteBack(restored, mask, transform, Math.min(Math.max(blend, 0), 1))
  }
}
