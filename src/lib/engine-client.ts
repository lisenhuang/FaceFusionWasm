/**
 * engine-client.ts
 *
 * The page's side of the worker link.
 *
 * Requests are promise-shaped and typed by their name, so a caller cannot ask
 * for `swapFrame` and be handed a manifest. Events — download progress, scan
 * progress, export progress — arrive out of band on subscriptions, because they
 * belong to a request that has not finished yet.
 */

import type {
  EngineEvent,
  EngineRequest,
  EngineResponses,
  RequestEnvelope,
  ResponseEnvelope,
  SerializedError,
  TransferableImage,
} from '@/worker/protocol'
import { isEventEnvelope } from '@/worker/protocol'

export class EngineRequestError extends Error {
  readonly code?: string
  readonly detail?: string

  constructor(error: SerializedError) {
    super(error.message)
    this.name = 'EngineRequestError'
    this.code = error.code
    this.detail = error.detail
  }
}

type Listener = (event: EngineEvent) => void

export class EngineClient {
  private worker: Worker | null = null
  private nextID = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  private readonly listeners = new Set<Listener>()

  /** Started lazily: nothing about the worker is useful before the page mounts. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), {
      type: 'module',
      name: 'facefusion-engine',
    })
    worker.onmessage = (event: MessageEvent<ResponseEnvelope>) => {
      const message = event.data
      if (isEventEnvelope(message)) {
        for (const listener of this.listeners) listener(message.event)
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new EngineRequestError(message.error))
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The engine stopped unexpectedly.')
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    this.worker = worker
    return worker
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * @returns the request id alongside the promise, so a long-running call can be
   *   cancelled by name. Cancellation is a separate message rather than an
   *   `AbortSignal` because the worker has to hear it while it is busy.
   */
  start<T extends EngineRequest['type']>(
    request: Extract<EngineRequest, { type: T }>,
    transfer: Transferable[] = [],
  ): { id: number; done: Promise<EngineResponses[T]> } {
    const worker = this.ensureWorker()
    const id = this.nextID
    this.nextID += 1

    const done = new Promise<EngineResponses[T]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      const envelope: RequestEnvelope = { id, request }
      worker.postMessage(envelope, transfer)
    })
    return { id, done }
  }

  send<T extends EngineRequest['type']>(
    request: Extract<EngineRequest, { type: T }>,
    transfer: Transferable[] = [],
  ): Promise<EngineResponses[T]> {
    return this.start(request, transfer).done
  }

  cancel(id: number) {
    if (!this.worker) return
    this.send({ type: 'cancel', id })
  }

  /**
   * Drops the worker, and fails everything that was waiting on it.
   *
   * Rejecting rather than clearing is the whole point. A pending entry is a
   * promise some caller is awaiting, and a promise that is neither resolved nor
   * rejected is a UI that waits for the rest of the session — which is precisely
   * the state this method is usually called to get out of.
   */
  terminate(reason = 'The engine was stopped.') {
    this.worker?.terminate()
    this.worker = null
    const error = new Error(reason)
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}

// MARK: - Image bridging

/**
 * Copies canvas pixels into a buffer the worker can take ownership of.
 *
 * Always a copy: the page keeps the untouched frame for the before/after
 * toggle, and a transferred buffer is detached on this side.
 */
export function toTransferableImage(source: ImageData): TransferableImage {
  const copy = new Uint8ClampedArray(source.data)
  return { width: source.width, height: source.height, buffer: copy.buffer }
}

export function fromTransferableImage(image: TransferableImage): ImageData {
  return new ImageData(new Uint8ClampedArray(image.buffer), image.width, image.height)
}
