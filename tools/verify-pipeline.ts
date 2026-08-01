/**
 * verify-pipeline.ts
 *
 * Runs the browser engine's own modules against the real ONNX models, in Node,
 * and checks the numbers against ground truth captured from the reference
 * FaceFusion pipeline.
 *
 * The point is that nothing here is a re-implementation for testing. `src/engine`
 * imports no browser API, so this harness loads the exact modules the worker
 * loads and swaps only the ONNX Runtime backend — which is what makes a green
 * run evidence about the shipping code rather than about a parallel copy.
 *
 *     pnpm verify:pipeline [--models <dir>] [--assets <dir>]
 *
 * Defaults point at the macOS app's model container and self-test assets, so on
 * a machine where that app has been run there is nothing to stage.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'

import ort from 'onnxruntime-node'
import sharp from 'sharp'

import { RGBAImage } from '../src/engine/image'
import { readLastInitializer } from '../src/engine/onnx-initializer'
import { SwapPipeline, modelSourceFrom } from '../src/engine/pipeline'
import { makeLoader, type OrtNamespace } from '../src/engine/runtime'
import { Sha256 } from '../src/engine/sha256'
import { FaceClusterer } from '../src/engine/clustering'
import { MODEL_IDS, type ModelID, defaultSwapOptions, identityDistance } from '../src/engine/types'

// MARK: - Ground truth
//
// Captured from the reference FaceFusion 3.8.0 run and mirrored in the macOS
// app's PipelineIntegrationTests, so the two ports are held to one standard.

/** First values of inswapper's `emap`, read independently with the onnx package. */
const EMAP_HEAD = [0.124847, -0.008458, 0.080384, -0.122, 0.640718, 0.006046]

/** Detector key points on examples-3.0.0/source.jpg (1024×1024). */
const SOURCE_LANDMARKS: [number, number][] = [
  [382.68265, 486.78732],
  [642.30164, 487.2053],
  [493.47028, 645.12103],
  [394.67697, 713.11646],
  [629.9115, 712.654],
]

// MARK: - Harness plumbing

const GREEN = '[32m'
const RED = '[31m'
const DIM = '[2m'
const RESET = '[0m'

let failures = 0
let checks = 0

function check(name: string, ok: boolean, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  } else {
    failures += 1
    console.log(`  ${RED}✗ ${name}${RESET} ${detail}`)
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

// MARK: - Image IO

async function loadImage(path: string): Promise<RGBAImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return new RGBAImage(info.width, info.height, new Uint8ClampedArray(data.buffer, data.byteOffset, data.length))
}

async function writeImage(image: RGBAImage, path: string) {
  await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toFile(path)
}

/** Mean absolute per-channel difference over RGB, ignoring alpha. */
function meanAbsoluteDifference(a: RGBAImage, b: RGBAImage): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity
  let total = 0
  for (let i = 0; i < a.data.length; i += 4) {
    total += Math.abs(a.data[i] - b.data[i])
    total += Math.abs(a.data[i + 1] - b.data[i + 1])
    total += Math.abs(a.data[i + 2] - b.data[i + 2])
  }
  return total / (a.width * a.height * 3)
}

// MARK: - Main

async function main() {
  const modelsDir =
    argument('--models') ??
    join(
      homedir(),
      'Library/Group Containers/HPL74FCW8E.com.lisenhuang.FaceFusionMac/Models',
    )
  const assetsDir =
    argument('--assets') ??
    join(
      homedir(),
      'Library/Group Containers/HPL74FCW8E.com.lisenhuang.FaceFusionMac/SelfTest',
    )
  const outDir = argument('--out') ?? join(process.cwd(), '.verify-out')

  console.log(`${DIM}models  ${modelsDir}${RESET}`)
  console.log(`${DIM}assets  ${assetsDir}${RESET}`)

  const sourcePath = join(assetsDir, 'source.jpg')
  if (!existsSync(sourcePath)) {
    console.error(
      `\n${RED}No source.jpg under ${assetsDir}.${RESET}\n` +
        `Pass --assets <dir> with source.jpg (and optionally output.png from the macOS app).`,
    )
    process.exit(2)
  }
  await mkdir(outDir, { recursive: true })

  // ---------------------------------------------------------------- sha256

  section('Streaming SHA-256')
  {
    const sample = new Uint8Array(1_000_037)
    for (let i = 0; i < sample.length; i += 1) sample[i] = (i * 31 + 7) & 0xff

    const streaming = new Sha256()
    // Deliberately ragged chunks: the block carry-over is the part that breaks.
    for (let offset = 0; offset < sample.length; ) {
      const size = Math.min(1 + ((offset * 7919) % 9973), sample.length - offset)
      streaming.update(sample.subarray(offset, offset + size))
      offset += size
    }
    const mine = streaming.digest()

    const reference = Buffer.from(
      await webcrypto.subtle.digest('SHA-256', sample),
    ).toString('hex')
    check('matches WebCrypto over ragged chunks', mine === reference, mine.slice(0, 16))

    const empty = new Sha256().digest()
    check(
      'empty input',
      empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  }

  // ------------------------------------------------------------- clustering

  section('Face clustering')
  {
    const clusterer = new FaceClusterer(0.5)
    // A plain phase-shifted sine is a poor stand-in for two people: same
    // frequency, so the two vectors stay strongly correlated and land inside
    // the threshold. A counter-based PRNG gives genuinely uncorrelated
    // directions, which is what two different faces actually look like.
    const unit = (seed: number) => {
      const vector = new Float32Array(512)
      let state = seed * 0x9e3779b1
      let magnitude = 0
      for (let i = 0; i < 512; i += 1) {
        state = (state ^ (state << 13)) >>> 0
        state = (state ^ (state >>> 17)) >>> 0
        state = (state ^ (state << 5)) >>> 0
        vector[i] = state / 0xffffffff - 0.5
        magnitude += vector[i] * vector[i]
      }
      magnitude = Math.sqrt(magnitude)
      for (let i = 0; i < 512; i += 1) vector[i] /= magnitude
      return { vector }
    }
    const alice = unit(1)
    const bob = unit(2)
    check(
      'the two fixtures really are different people',
      identityDistance(alice, bob) > 0.5,
      `distance ${identityDistance(alice, bob).toFixed(3)}`,
    )

    const first = clusterer.add(alice, 0, 0.9, 0.05)
    const second = clusterer.add(alice, 4, 0.9, 0.2)
    const third = clusterer.add(bob, 2, 0.9, 0.01)

    check('same identity merges', first.id === second.id && !second.isNew)
    check('different identity splits', third.id !== first.id && third.isNew)
    check('bigger look wins the thumbnail', second.isBestSoFar)
    const people = clusterer.byProminence()
    check('ordered by prominence', people.length === 2 && people[0].id === first.id)
    check(
      'span accumulates',
      people[0].firstSeen === 0 && people[0].lastSeen === 4 && people[0].appearances === 2,
    )
  }

  // ------------------------------------------------------------- model bytes

  section('Models')
  const bytes: Partial<Record<ModelID, Uint8Array>> = {}
  for (const id of MODEL_IDS) {
    const path = join(modelsDir, `${id}.onnx`)
    if (!existsSync(path)) {
      console.log(`  ${DIM}- ${id} not present, skipping${RESET}`)
      continue
    }
    const buffer = await readFile(path)
    bytes[id] = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length)
    console.log(`  ${DIM}· ${id} ${(buffer.length / 1e6).toFixed(1)} MB${RESET}`)
  }

  const swapperBytes = bytes.inswapper_128_fp16
  if (!swapperBytes) {
    console.error(`\n${RED}inswapper_128_fp16.onnx is required.${RESET}`)
    process.exit(2)
  }

  // ------------------------------------------------------- emap extraction

  section('ONNX initializer walker')
  {
    const tensor = readLastInitializer(swapperBytes)
    check(
      'emap dims are 512×512',
      tensor.dims.length === 2 && tensor.dims[0] === 512 && tensor.dims[1] === 512,
      `[${tensor.dims.join(', ')}]`,
    )
    check('emap is float32', tensor.dataType === 1)
    check('emap value count', tensor.values.length === 512 * 512)
    const head = EMAP_HEAD.every((want, i) => Math.abs(tensor.values[i] - want) < 1e-5)
    check(
      'emap head matches reference',
      head,
      `[${Array.from(tensor.values.slice(0, 3))
        .map((v) => v.toFixed(6))
        .join(', ')}…]`,
    )
  }

  // ------------------------------------------------------------- inference

  const loader = makeLoader(
    ort as unknown as OrtNamespace,
    { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
    { provider: 'onnxruntime-node (CPU)', usingGPU: false },
  )

  const pipeline = new SwapPipeline()
  section('Engine preparation')
  const preparation = await pipeline.prepare(loader, modelSourceFrom(bytes))
  check(
    'models loaded',
    preparation.loadedModels.length >= 3,
    preparation.loadedModels.join(', '),
  )
  for (const warning of preparation.warnings) console.log(`  ${DIM}! ${warning}${RESET}`)
  console.log(`  ${DIM}warm-up ${preparation.warmupSeconds.toFixed(1)}s${RESET}`)

  const source = await loadImage(sourcePath)
  console.log(`  ${DIM}source ${source.width}×${source.height}${RESET}`)

  // --------------------------------------------------------- detector check

  section('Detector')
  {
    const analysis = await pipeline.detectFaces(source)
    check('found a face', analysis.faces.length > 0, `${analysis.faces.length} face(s)`)

    const face = analysis.faces.reduce((best, candidate) =>
      candidate.box.width * candidate.box.height > best.box.width * best.box.height
        ? candidate
        : best,
    )

    // 1024×1024 is the size the reference points were captured at. A different
    // source image is still worth running, but the coordinates cannot be
    // compared against numbers taken from another picture.
    if (source.width === 1024 && source.height === 1024) {
      let worst = 0
      face.landmarks.forEach((point, index) => {
        const expected = SOURCE_LANDMARKS[index]
        worst = Math.max(worst, Math.hypot(point[0] - expected[0], point[1] - expected[1]))
      })
      check(
        'key points match the reference within 2px',
        worst < 2,
        `worst ${worst.toFixed(2)}px`,
      )
    } else {
      console.log(
        `  ${DIM}- source is ${source.width}×${source.height}, not the 1024² reference image; skipping coordinate check${RESET}`,
      )
    }
  }

  // -------------------------------------------------------- conditioning

  section('Source identity')
  {
    // The reference aligned the source from the detector's key points, so
    // refinement is off for the vectors to be comparable.
    const analysis = await pipeline.analyzeSource(source, false)
    check('encoded the source face', analysis.face !== null, `${analysis.faceCount} face(s)`)

    const conditioning = pipeline.debugConditioningVector()
    check('conditioning vector is 512-d', conditioning?.length === 512)

    if (conditioning) {
      let magnitude = 0
      let finite = true
      for (const value of conditioning) {
        magnitude += value * value
        if (!Number.isFinite(value)) finite = false
      }
      magnitude = Math.sqrt(magnitude)
      check('conditioning is finite', finite)
      // Dividing by the magnitude of the *pre-projection* embedding is the step
      // that is easy to get wrong, and it is what puts this near unit length:
      // `emap` is close to a rotation, so ‖(e · emap) / ‖e‖‖ ≈ 1. Dividing by
      // the projected magnitude instead would pin this at exactly 1.0, and
      // skipping the division entirely would put it around 20.
      check(
        'conditioning is near unit length',
        magnitude > 0.5 && magnitude < 2 && Math.abs(magnitude - 1) > 1e-6,
        `‖v‖ = ${magnitude.toFixed(4)}`,
      )
    }
  }

  // ------------------------------------------------------------ full swap

  section('Full swap (source portrait as its own target)')
  {
    // Re-encode the source the way the app does, with refinement on, so the
    // exported frame reflects shipping defaults rather than the comparison
    // configuration used above.
    await pipeline.analyzeSource(source, true)

    const output = new RGBAImage(source.width, source.height)
    const started = Date.now()
    const result = await pipeline.swap(source, output, {
      ...defaultSwapOptions,
      selection: { kind: 'largest' },
      enhanceFace: pipeline.hasEnhancer,
    })
    const seconds = (Date.now() - started) / 1000

    check('swapped one face', result.facesSwapped === 1, `of ${result.facesFound} found`)
    console.log(
      `  ${DIM}${seconds.toFixed(1)}s — detect ${(result.stages.detect * 1000) | 0}ms · ` +
        `landmarks ${(result.stages.landmarks * 1000) | 0}ms · ` +
        `swap ${(result.stages.swap * 1000) | 0}ms · ` +
        `paste ${(result.stages.paste * 1000) | 0}ms · ` +
        `enhance ${(result.stages.enhance * 1000) | 0}ms${RESET}`,
    )

    const changed = meanAbsoluteDifference(output, source)
    check('output differs from the input', changed > 1, `mean |Δ| ${changed.toFixed(2)}`)

    const path = join(outDir, 'swap.png')
    await writeImage(output, path)
    console.log(`  ${DIM}wrote ${path}${RESET}`)

    // The macOS app's own self-test writes output.png from this same input with
    // the same defaults. Core ML and ORT's CPU kernels differ in float ordering,
    // so an exact match is not the bar — a visually identical frame is.
    const referencePath = join(assetsDir, 'output.png')
    if (existsSync(referencePath)) {
      const reference = await loadImage(referencePath)
      const difference = meanAbsoluteDifference(output, reference)
      check(
        'matches the macOS app output',
        difference < 6,
        `mean |Δ| ${difference.toFixed(2)} / 255`,
      )
    } else {
      console.log(`  ${DIM}- no output.png to compare against${RESET}`)
    }
  }

  // ----------------------------------------------------------- identities

  section('Identity matching')
  {
    const analysis = await pipeline.analyzeFaces(source, {
      detectorScore: 0.5,
      refineLandmarks: true,
      includeIdentities: true,
    })
    check(
      'identities are parallel to faces',
      analysis.identities.length === analysis.faces.length,
      `${analysis.faces.length} face(s)`,
    )
    if (analysis.identities.length > 0) {
      const identity = analysis.identities[0]
      let magnitude = 0
      for (const value of identity.vector) magnitude += value * value
      check(
        'identity is unit length',
        Math.abs(Math.sqrt(magnitude) - 1) < 1e-4,
        `‖v‖ = ${Math.sqrt(magnitude).toFixed(6)}`,
      )

      // A reference set holding this exact face must select it, and an empty
      // one must select nothing — the two ends of the generation contract.
      pipeline.setReferenceFaces({ generation: 7, identities: [identity] })
      const matched = await pipeline.swap(source, new RGBAImage(source.width, source.height), {
        ...defaultSwapOptions,
        enhanceFace: false,
        selection: { kind: 'reference', generation: 7, maxDistance: 0.6 },
      })
      check('reference selection matches its own identity', matched.facesSwapped === 1)

      let refused = false
      try {
        await pipeline.swap(source, new RGBAImage(source.width, source.height), {
          ...defaultSwapOptions,
          enhanceFace: false,
          selection: { kind: 'reference', generation: 8, maxDistance: 0.6 },
        })
      } catch (error) {
        refused = (error as { code?: string }).code === 'referenceFacesStale'
      }
      check('a stale generation is refused, not guessed', refused)
    }
  }

  await pipeline.unloadAll()

  // ------------------------------------------------------------------ done

  console.log(
    `\n${failures === 0 ? GREEN : RED}${checks - failures}/${checks} checks passed${RESET}\n`,
  )
  await writeFile(
    join(outDir, 'summary.json'),
    JSON.stringify({ checks, failures, provider: loader.provider }, null, 2),
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n${RED}harness failed${RESET}`, error)
  process.exit(1)
})
