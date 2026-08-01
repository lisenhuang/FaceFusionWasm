/**
 * onnx-initializer.ts
 *
 * The inswapper graph carries a 512×512 matrix ("emap") as its last graph
 * initializer. The source identity embedding has to be projected through that
 * matrix before the model will accept it, and ONNX Runtime offers no way to
 * read a graph initializer back out. So we read it straight from the file.
 *
 * Rather than pull in a protobuf dependency, this walks just the handful of
 * fields we need, over a `Uint8Array` view of the model bytes — no copying, and
 * the multi-hundred-megabyte weight blobs are skipped rather than decoded.
 *
 * Relevant schema (onnx.proto):
 *   ModelProto.graph        = field 7  (message)
 *   GraphProto.initializer  = field 5  (repeated TensorProto)
 *   TensorProto.dims        = field 1  (repeated int64, possibly packed)
 *   TensorProto.data_type   = field 2  (enum/varint)
 *   TensorProto.float_data  = field 4  (repeated float, packed)
 *   TensorProto.name        = field 8  (string)
 *   TensorProto.raw_data    = field 9  (bytes)
 */

import { engineError } from './types'

export interface OnnxTensor {
  name: string
  dims: number[]
  /** ONNX TensorProto.DataType — 1 = FLOAT, 10 = FLOAT16. */
  dataType: number
  values: Float32Array
}

type Payload =
  | { kind: 'varint'; value: number }
  | { kind: 'bytes'; start: number; end: number }
  | { kind: 'fixed'; start: number; end: number }

interface Field {
  number: number
  payload: Payload
}

class Reader {
  readonly buf: Uint8Array
  index: number
  readonly end: number

  constructor(buf: Uint8Array, index: number, end: number) {
    this.buf = buf
    this.index = index
    this.end = end
  }

  varint(): number {
    let result = 0
    let shift = 0
    while (this.index < this.end) {
      const byte = this.buf[this.index]
      this.index += 1
      // Beyond 2^53 the arithmetic would silently lose precision, but no field
      // we read here — dims, data types, lengths — comes close.
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
      shift += 7
      if (shift > 63) throw engineError('modelLoadFailed', 'varint overflow')
    }
    throw engineError('modelLoadFailed', 'truncated varint')
  }

  nextField(): Field | null {
    if (this.index >= this.end) return null
    const key = this.varint()
    const number = key >>> 3
    switch (key & 7) {
      case 0:
        return { number, payload: { kind: 'varint', value: this.varint() } }
      case 1: {
        if (this.index + 8 > this.end) throw this.truncated()
        const start = this.index
        this.index += 8
        return { number, payload: { kind: 'fixed', start, end: start + 8 } }
      }
      case 2: {
        const length = this.varint()
        if (length < 0 || this.index + length > this.end) throw this.truncated()
        const start = this.index
        this.index += length
        return { number, payload: { kind: 'bytes', start, end: start + length } }
      }
      case 5: {
        if (this.index + 4 > this.end) throw this.truncated()
        const start = this.index
        this.index += 4
        return { number, payload: { kind: 'fixed', start, end: start + 4 } }
      }
      default:
        throw engineError('modelLoadFailed', 'unsupported wire type')
    }
  }

  private truncated() {
    return engineError('modelLoadFailed', 'truncated protobuf field')
  }
}

/** Reads the final graph initializer, which for inswapper is `emap`. */
export function readLastInitializer(bytes: Uint8Array): OnnxTensor {
  // ModelProto → graph (field 7)
  let graphSpan: { start: number; end: number } | null = null
  const cursor = new Reader(bytes, 0, bytes.length)
  for (let field = cursor.nextField(); field; field = cursor.nextField()) {
    if (field.number === 7 && field.payload.kind === 'bytes') {
      graphSpan = { start: field.payload.start, end: field.payload.end }
    }
  }
  if (!graphSpan) throw engineError('modelLoadFailed', 'no GraphProto in model')

  // GraphProto → initializer (field 5), keeping only the last one.
  let lastInit: { start: number; end: number } | null = null
  const graphCursor = new Reader(bytes, graphSpan.start, graphSpan.end)
  for (let field = graphCursor.nextField(); field; field = graphCursor.nextField()) {
    if (field.number === 5 && field.payload.kind === 'bytes') {
      lastInit = { start: field.payload.start, end: field.payload.end }
    }
  }
  if (!lastInit) throw engineError('modelLoadFailed', 'graph has no initializers')

  return parseTensor(bytes, lastInit)
}

function parseTensor(
  bytes: Uint8Array,
  span: { start: number; end: number },
): OnnxTensor {
  let name = ''
  const dims: number[] = []
  let dataType = 0
  let rawData: { start: number; end: number } | null = null
  let packedFloats: { start: number; end: number } | null = null

  const cursor = new Reader(bytes, span.start, span.end)
  for (let field = cursor.nextField(); field; field = cursor.nextField()) {
    const { number, payload } = field
    if (number === 1 && payload.kind === 'varint') {
      dims.push(payload.value)
    } else if (number === 1 && payload.kind === 'bytes') {
      // Packed dims.
      const packed = new Reader(bytes, payload.start, payload.end)
      while (packed.index < packed.end) dims.push(packed.varint())
    } else if (number === 2 && payload.kind === 'varint') {
      dataType = payload.value
    } else if (number === 4 && payload.kind === 'bytes') {
      packedFloats = { start: payload.start, end: payload.end }
    } else if (number === 8 && payload.kind === 'bytes') {
      name = new TextDecoder().decode(bytes.subarray(payload.start, payload.end))
    } else if (number === 9 && payload.kind === 'bytes') {
      rawData = { start: payload.start, end: payload.end }
    }
  }

  const count = dims.reduce((total, dim) => total * dim, 1)
  let values: Float32Array

  if (rawData) {
    const length = rawData.end - rawData.start
    if (dataType === 1) {
      const expected = count * 4
      if (length < expected) {
        throw engineError(
          'modelLoadFailed',
          `initializer raw_data too short (${length} < ${expected})`,
        )
      }
      // raw_data has no alignment guarantee inside the file, so copy rather
      // than aliasing a Float32Array onto the buffer.
      values = new Float32Array(count)
      const view = new DataView(bytes.buffer, bytes.byteOffset + rawData.start, expected)
      for (let i = 0; i < count; i += 1) values[i] = view.getFloat32(i * 4, true)
    } else if (dataType === 10) {
      const expected = count * 2
      if (length < expected) {
        throw engineError('modelLoadFailed', 'initializer raw_data too short')
      }
      values = new Float32Array(count)
      const view = new DataView(bytes.buffer, bytes.byteOffset + rawData.start, expected)
      for (let i = 0; i < count; i += 1) {
        values[i] = float16ToFloat32(view.getUint16(i * 2, true))
      }
    } else {
      throw engineError('modelLoadFailed', `unsupported initializer dtype ${dataType}`)
    }
  } else if (packedFloats) {
    const n = Math.floor((packedFloats.end - packedFloats.start) / 4)
    values = new Float32Array(n)
    const view = new DataView(bytes.buffer, bytes.byteOffset + packedFloats.start, n * 4)
    for (let i = 0; i < n; i += 1) values[i] = view.getFloat32(i * 4, true)
  } else {
    throw engineError('modelLoadFailed', 'initializer carries no data')
  }

  return { name, dims, dataType, values }
}

/**
 * IEEE 754 half → single. `DataView` has no `getFloat16` in every runtime we
 * target, and this is only ever hit once per model load.
 */
export function float16ToFloat32(bits: number): number {
  const sign = (bits & 0x8000) >> 15
  const exponent = (bits & 0x7c00) >> 10
  const fraction = bits & 0x03ff
  const magnitude =
    exponent === 0
      ? 6.103515625e-5 * (fraction / 1024)
      : exponent === 0x1f
        ? fraction === 0
          ? Infinity
          : NaN
        : 2 ** (exponent - 15) * (1 + fraction / 1024)
  return sign ? -magnitude : magnitude
}
