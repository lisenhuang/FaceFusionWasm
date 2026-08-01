/**
 * runtime.ts
 *
 * The seam between the pipeline and ONNX Runtime.
 *
 * The pipeline never imports a runtime package. It is handed a `ModelLoader`,
 * which the browser worker builds from `onnxruntime-web` and the verification
 * harness builds from `onnxruntime-node`. The two packages present the same
 * `InferenceSession` / `Tensor` surface, so one adapter covers both — and it is
 * what lets the whole pipeline be exercised in Node against the real models
 * without a browser.
 */

import type { FloatTensor } from './image'
import { type ModelID, engineError } from './types'

export interface ORTModel {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  /**
   * @param fetches names to retrieve. Omit for all outputs — worth naming when
   *   a graph emits something large that is not wanted, since every output has
   *   to be copied back out of the GPU.
   */
  run(
    feeds: Record<string, FloatTensor>,
    fetches?: readonly string[],
  ): Promise<Record<string, FloatTensor>>
  release(): Promise<void>
}

export interface LoadOptions {
  /** Pins a symbolic input dimension, e.g. ArcFace's dynamic batch. */
  freeDimensionOverrides?: Record<string, number>
}

export interface ModelLoader {
  /** Human-readable name of what actually ran the graphs. */
  readonly provider: string
  readonly usingGPU: boolean
  load(id: ModelID, bytes: Uint8Array, options?: LoadOptions): Promise<ORTModel>
}

// MARK: - Adapter over an ort-like namespace

interface OrtTensorLike {
  type: string
  dims: readonly number[]
  data: unknown
}

interface OrtSessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(
    feeds: Record<string, OrtTensorLike>,
    fetches?: readonly string[] | Record<string, unknown>,
  ): Promise<Record<string, OrtTensorLike>>
  release(): Promise<void>
}

export interface OrtNamespace {
  InferenceSession: {
    create(buffer: Uint8Array, options?: unknown): Promise<OrtSessionLike>
  }
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: readonly number[],
  ) => OrtTensorLike
}

/**
 * Runs tasks strictly one at a time.
 *
 * ONNX Runtime Web's WebGPU backend keeps one command encoder and one program
 * cache per module, shared by every session it builds. Two `run()` calls in
 * flight at once therefore interleave inside state that assumes a single
 * caller, and the symptom is not a clean error but a failed or wrong frame —
 * which is exactly what happens in this app, where a face scan, a preview and
 * an export can all be pending at the same moment.
 *
 * The macOS engine solved the same problem with a lock per `ORTSession`. Here
 * the lock has to be one level up, because the contended resource is the
 * backend rather than any individual session.
 *
 * Nothing is lost by serialising. The GPU executes one graph at a time
 * regardless; overlapping submissions only ever bought queueing.
 */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    // `then(task, task)` rather than `then(task)`: a failed predecessor must
    // still let the next task start, or one bad frame stops the engine.
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

class AdaptedModel implements ORTModel {
  private readonly ort: OrtNamespace
  private readonly session: OrtSessionLike
  private readonly id: ModelID
  private readonly serializer: Serializer

  constructor(
    ort: OrtNamespace,
    session: OrtSessionLike,
    id: ModelID,
    serializer: Serializer,
  ) {
    this.ort = ort
    this.session = session
    this.id = id
    this.serializer = serializer
  }

  get inputNames() {
    return this.session.inputNames
  }

  get outputNames() {
    return this.session.outputNames
  }

  async run(feeds: Record<string, FloatTensor>, fetches?: readonly string[]) {
    const inputs: Record<string, OrtTensorLike> = {}
    for (const [name, tensor] of Object.entries(feeds)) {
      inputs[name] = new this.ort.Tensor('float32', tensor.data, tensor.shape)
    }

    let raw: Record<string, OrtTensorLike>
    try {
      raw = await this.serializer.run(() => this.session.run(inputs, fetches))
    } catch (cause) {
      throw engineError(
        'inferenceFailed',
        `${this.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    const outputs: Record<string, FloatTensor> = {}
    for (const [name, tensor] of Object.entries(raw)) {
      outputs[name] = {
        shape: Array.from(tensor.dims),
        data: toFloat32(tensor.data),
      }
    }
    return outputs
  }

  release() {
    return this.session.release()
  }
}

function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data
  if (ArrayBuffer.isView(data)) {
    // fp16 graphs can hand back a Uint16Array-backed half tensor; the models
    // here all declare float32 IO, so anything else is a genuine surprise.
    return Float32Array.from(data as unknown as ArrayLike<number>)
  }
  throw engineError('inferenceFailed', 'model returned a non-numeric tensor')
}

/**
 * Wraps an ort namespace as a `ModelLoader`.
 *
 * `sessionOptions` is passed straight through, so the caller decides execution
 * providers and threading; nothing about those choices belongs in the pipeline.
 */
export function makeLoader(
  ort: OrtNamespace,
  sessionOptions: Record<string, unknown>,
  describe: { provider: string; usingGPU: boolean },
  /**
   * Shared so that a WebGPU loader and its WASM fallback take turns rather than
   * running at once — they are backed by the same runtime module.
   */
  serializer: Serializer = new Serializer(),
): ModelLoader {
  return {
    provider: describe.provider,
    usingGPU: describe.usingGPU,
    async load(id, bytes, options) {
      const merged: Record<string, unknown> = { ...sessionOptions }
      if (options?.freeDimensionOverrides) {
        merged.freeDimensionOverrides = options.freeDimensionOverrides
      }
      try {
        const session = await ort.InferenceSession.create(bytes, merged)
        return new AdaptedModel(ort, session, id, serializer)
      } catch (cause) {
        throw engineError(
          'modelLoadFailed',
          `${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    },
  }
}
