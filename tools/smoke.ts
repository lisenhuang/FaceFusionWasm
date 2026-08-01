/**
 * smoke.ts
 *
 * Drives the running app in a real browser and reports what it finds.
 *
 * The pipeline is verified separately, against ground truth, by
 * `verify-pipeline.ts`. What this covers is everything that only exists in a
 * browser: that the worker starts, that OPFS and WebGPU are reachable from
 * inside it, that the manifest loads, and that the two layouts render without
 * console errors.
 *
 *     pnpm smoke [--url http://localhost:3000] [--models <dir>] [--headed]
 *
 * With `--models`, the manifest is rewritten to point at a local file server so the
 * install runs for real — streaming, hashing, verifying — without a 900 MB download,
 * and the run continues through engine start-up and a real swap.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, type ConsoleMessage } from 'playwright'

const GREEN = '[32m'
const RED = '[31m'
const DIM = '[2m'
const RESET = '[0m'

let checks = 0
let failures = 0

function check(name: string, ok = true, detail = '') {
  checks += 1
  if (ok) console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  else {
    failures += 1
    console.log(`  ${RED}✗ ${name}${RESET} ${detail}`)
  }
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const MODEL_FILES = [
  'yoloface_8n.onnx',
  'arcface_w600k_r50.onnx',
  'inswapper_128_fp16.onnx',
  '2dfan4.onnx',
  'gfpgan_1.4.onnx',
]

async function main() {
  const url = argument('--url') ?? 'http://localhost:3000'
  const modelsDir =
    argument('--models') ??
    join(homedir(), 'Library/Group Containers/HPL74FCW8E.com.lisenhuang.FaceFusionMac/Models')
  const assetsDir =
    argument('--assets') ??
    join(homedir(), 'Library/Group Containers/HPL74FCW8E.com.lisenhuang.FaceFusionMac/SelfTest')
  const outDir = join(process.cwd(), '.verify-out')
  await mkdir(outDir, { recursive: true })

  // A persistent profile keeps OPFS between runs, so the 903 MB install happens
  // once rather than on every iteration. `--fresh` throws it away.
  const profileDir = argument('--profile') ?? join(outDir, 'profile')
  if (process.argv.includes('--fresh')) await rm(profileDir, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !process.argv.includes('--headed'),
    viewport: { width: 1280, height: 860 },
    args: [
      // Headless Chromium keeps WebGPU behind a flag; without it the run would
      // only ever exercise the WASM fallback.
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=metal',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const page = context.pages()[0] ?? (await context.newPage())

  const errors: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  // A renderer that runs out of memory loading ~900 MB of weights fails as a
  // crash, not an exception, and every later step then times out for reasons
  // that look unrelated.
  page.on('crash', () => errors.push('the renderer process crashed'))

  console.log(`${DIM}${url}${RESET}\n`)
  console.log('Page')
  await page.goto(url, { waitUntil: 'networkidle' })

  check('cross-origin isolated', await page.evaluate(() => crossOriginIsolated))
  check(
    'browser support gate passed',
    !(await page.getByText('This browser is missing some pieces').isVisible()),
  )

  // With a warm profile the models are already in OPFS and the app opens
  // straight into the studio, so the first-run screen is checked only when it
  // is the screen that is actually showing.
  const needsInstall = await page
    .waitForSelector('text=Set up FaceFusion', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)

  if (needsInstall) {
    check('onboarding rendered')
    check(
      'manifest listed every model',
      (await page.getByText('Face Swapper').count()) > 0 &&
        (await page.getByText('Identity Encoder').count()) > 0,
    )
    const downloadLabel = await page.getByRole('button', { name: /Download/ }).textContent()
    check('download size shown', /Download \d+ MB/.test(downloadLabel ?? ''), downloadLabel ?? '')
    await page.screenshot({ path: join(outDir, 'shot-onboarding.png'), fullPage: true })
  } else {
    console.log(`  ${DIM}models already installed in this profile; skipping first-run checks${RESET}`)
  }

  // --------------------------------------------------------------- worker

  console.log('\nWorker environment')
  const workerReport = await page.evaluate(async () => {
    const source = `
      self.onmessage = async () => {
        const report = { opfs: false, webgpu: false, webcodecs: false, threads: 0, error: null };
        try {
          const root = await navigator.storage.getDirectory();
          await root.getDirectoryHandle('probe', { create: true });
          await root.removeEntry('probe', { recursive: true });
          report.opfs = true;
        } catch (error) { report.error = String(error); }
        try {
          report.webgpu = navigator.gpu ? (await navigator.gpu.requestAdapter()) !== null : false;
        } catch { report.webgpu = false; }
        report.webcodecs = typeof VideoEncoder !== 'undefined';
        report.threads = self.crossOriginIsolated ? (navigator.hardwareConcurrency || 1) : 1;
        self.postMessage(report);
      };
    `
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    return new Promise<Record<string, unknown>>((resolve) => {
      worker.onmessage = (event) => {
        worker.terminate()
        resolve(event.data)
      }
      worker.postMessage('go')
    })
  })

  check('OPFS reachable from a worker', workerReport.opfs === true, String(workerReport.error ?? ''))
  check('WebCodecs reachable from a worker', workerReport.webcodecs === true)
  check(
    'WebGPU adapter available',
    workerReport.webgpu === true,
    workerReport.webgpu ? '' : '(falls back to WASM — expected in some headless setups)',
  )
  console.log(`  ${DIM}wasm threads available: ${workerReport.threads}${RESET}`)

  // --------------------------------------------------------------- layout

  console.log('\nMobile layout')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check('no horizontal overflow at 390px', overflow <= 1, `${overflow}px`)
  await page.screenshot({ path: join(outDir, 'shot-onboarding-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 860 })

  // --------------------------------------------------------------- engine

  const haveModels = MODEL_FILES.every((name) => existsSync(join(modelsDir, name)))
  if (needsInstall && !haveModels) {
    console.log(`\n${DIM}No local models under ${modelsDir}; skipping the engine run.${RESET}`)
    await finish(context, errors, outDir)
    return
  }

  if (needsInstall) {
    // Rather than write the weights into OPFS by hand, point the manifest at a
    // local file server and let the app install them the way a user would. The
    // files are the genuine release assets, so the digests in the manifest still
    // apply — which means this exercises the streaming download, the resumable
    // writer and the checksum gate rather than stepping around them.
    console.log('\nInstalling models through the app')
    const origin = await serveModels(modelsDir)
    console.log(`  ${DIM}serving ${modelsDir} at ${origin}${RESET}`)

    await page.route('**/models.json', async (route) => {
      const response = await route.fetch()
      const manifest = JSON.parse(await response.text())
      for (const model of manifest.models) {
        model.url = `${origin}/${model.id}.onnx`
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(manifest),
      })
    })

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('text=Set up FaceFusion', { timeout: 30_000 })

    // The rewritten manifest is now in the worker's hands, so the interception
    // has done its job. Removing it matters: while any route is registered,
    // Playwright pauses and resumes every request over CDP, and paying that on
    // ~900 MB of model traffic turns a fast local transfer into a crawl.
    await page.unroute('**/models.json')

    await page.getByRole('button', { name: /Download/ }).click()

    // Roughly 900 MB streamed, hashed and moved into place. Printing the app's
    // own progress line makes a stall visible instead of indistinguishable from
    // slow.
    const installed = await waitForInstall(page, 900_000)
    check('models installed and verified in the browser', installed)

    const stored = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('models')
      const entries: string[] = []
      // @ts-expect-error - `keys()` is present on the handle at runtime.
      for await (const name of directory.keys()) entries.push(name as string)
      return entries.sort()
    })
    check(
      'OPFS holds exactly the installed models',
      stored.length === MODEL_FILES.length &&
        MODEL_FILES.every((name) => stored.includes(name)),
      stored.join(', '),
    )
  }

  // ------------------------------------------------------------------ studio

  {
    console.log('\nStudio')

    // Engine start-up loads ~900 MB of weights into the backend. Reading the
    // badge is the honest signal: it renders whatever the worker reported,
    // including a failure.
    const badge = await page
      .waitForFunction(
        () => {
          const text = document.body.innerText
          if (text.includes('Starting engine…')) return null
          const match = text.match(/(WebGPU[^\n]*|WebAssembly[^\n]*|Engine idle)/)
          return match ? match[1] : null
        },
        undefined,
        { timeout: 600_000, polling: 1000 },
      )
      .then((handle) => handle.jsonValue() as Promise<string | null>)
      .catch(() => null)

    check('engine reported a backend', Boolean(badge) && badge !== 'Engine idle', badge ?? 'still starting or failed')
    if (!badge) {
      console.log(`  ${DIM}${(await page.innerText('aside')).split('\n').slice(-6).join(' | ')}${RESET}`)
    }
    await page.screenshot({ path: join(outDir, 'shot-engine.png') })

    const sourcePath = join(assetsDir, 'source.jpg')
    if (existsSync(sourcePath)) {
      const inputs = page.locator('input[type=file]')
      check('both media wells present', (await inputs.count()) === 2, `${await inputs.count()} input(s)`)

      await inputs.nth(0).setInputFiles(sourcePath)
      await page.waitForSelector('text=/Face ready|Using the largest/', { timeout: 300_000 })
      check('source face encoded in the browser')

      // The portrait doubles as the target, exactly as the macOS self-test does.
      await inputs.nth(1).setInputFiles(sourcePath)
      await page.waitForSelector('text=Ready to export', { timeout: 300_000 })
      check('preview swap completed')
      await page.screenshot({ path: join(outDir, 'shot-studio.png'), fullPage: false })

      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(400)
      const mobileOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      check('studio has no horizontal overflow at 390px', mobileOverflow <= 1, `${mobileOverflow}px`)
      await page.screenshot({ path: join(outDir, 'shot-studio-mobile.png'), fullPage: false })

      // The preview is the one place a layout mistake is invisible in a
      // screenshot and wrong in a way that matters: a canvas whose box is taller
      // than its container gets silently cropped, and a cropped frame looks like
      // a bad crop rather than a bug. Measured at the narrow viewport, where the
      // container is furthest from the frame's own shape.
      const fit = await page.evaluate(() => {
        // The media wells hold canvases too, and they come first in the DOM.
        // The preview is the one whose parent also holds the face overlay.
        const element = Array.from(document.querySelectorAll('canvas')).find((c) =>
          c.parentElement?.querySelector('svg'),
        )
        if (!element) return null
        const box = element.getBoundingClientRect()
        const container = (element.parentElement?.parentElement as HTMLElement).getBoundingClientRect()
        return {
          boxWidth: Math.round(box.width),
          boxHeight: Math.round(box.height),
          containerWidth: Math.round(container.width),
          containerHeight: Math.round(container.height),
        }
      })
      check(
        'the preview canvas fits its container exactly',
        Boolean(fit) &&
          Math.abs(fit!.boxWidth - fit!.containerWidth) <= 1 &&
          Math.abs(fit!.boxHeight - fit!.containerHeight) <= 1,
        fit ? `${fit.boxWidth}×${fit.boxHeight} in ${fit.containerWidth}×${fit.containerHeight}` : 'no canvas',
      )

      await page.setViewportSize({ width: 1280, height: 860 })

      // ------------------------------------------------------- photo export

      console.log('\nPhoto export')
      await page.getByRole('button', { name: /Export photo/ }).click()
      const photoOutcome = await waitForExport(page, 300_000)
      check('photo export completed', photoOutcome.ok, photoOutcome.message)
      if (!photoOutcome.ok) {
        await page.screenshot({ path: join(outDir, 'shot-photo-failed.png') })
      }
      const photo = photoOutcome.ok ? await describeDownload(page) : { name: '', bytes: 0, url: '' }
      check('produced a PNG', photo.name.endsWith('.png'), photo.name)
      check('the PNG is a real file', photo.bytes > 10_000, `${(photo.bytes / 1e6).toFixed(2)} MB`)
      await page.getByRole('button', { name: 'Dismiss' }).click().catch(() => {})
    }

    // -------------------------------------------------------- video export

    const videoPath = join(assetsDir, 'target.mp4')
    if (existsSync(videoPath) && existsSync(join(assetsDir, 'source.jpg'))) {
      console.log('\nVideo export')
      const inputs = page.locator('input[type=file]')
      await inputs.nth(1).setInputFiles(videoPath)
      await page.waitForSelector('text=/H\\.264|HEVC|VP9|AV1/', { timeout: 120_000 })
      check('video target inspected')

      const sourceInfo = await page.evaluate(() => {
        const match = document.body.innerText.match(/(\d+×\d+ · \d+:\d+ · \S+)/)
        return match ? match[1] : ''
      })
      console.log(`  ${DIM}${sourceInfo}${RESET}`)

      // "Every" avoids needing a scan first, and is the mode with the least
      // machinery between the button and the encoder.
      await page.getByRole('tab', { name: 'Every' }).click()

      // Restoration off. It is the largest per-frame cost by a wide margin, and
      // the photo export above already ran it end to end — over a few hundred
      // frames it would only make this check slow enough that nobody runs it.
      // What is under test here is decode → swap → encode → mux.
      const enhance = page.locator('label', { hasText: 'Enhance detail' }).getByRole('switch')
      if ((await enhance.getAttribute('aria-checked')) === 'true') await enhance.click()

      await page.waitForSelector('text=Ready to export', { timeout: 300_000 })

      await page.getByRole('button', { name: /Export video/ }).click()
      const videoOutcome = await waitForExport(page, 900_000)
      check('video export completed', videoOutcome.ok, videoOutcome.message)
      if (!videoOutcome.ok) {
        await page.screenshot({ path: join(outDir, 'shot-video-failed.png') })
      }
      const video = videoOutcome.ok ? await describeDownload(page) : { name: '', bytes: 0, url: '' }
      check('produced an MP4', video.name.endsWith('.mp4'), video.name)
      check('the MP4 is a real file', video.bytes > 50_000, `${(video.bytes / 1e6).toFixed(2)} MB`)

      // Playing it back is the only check that says the muxing is right rather
      // than merely that bytes were written.
      const playback = !videoOutcome.ok
        ? { duration: 0, width: 0, height: 0 }
        : await page.evaluate(async (url: string) => {
            const element = document.createElement('video')
            element.src = url
            element.muted = true
            await new Promise<void>((resolve, reject) => {
              element.onloadedmetadata = () => resolve()
              element.onerror = () => reject(new Error('the exported file would not load'))
              setTimeout(() => reject(new Error('metadata never arrived')), 30_000)
            })
            return {
              duration: element.duration,
              width: element.videoWidth,
              height: element.videoHeight,
            }
          }, video.url)

      check(
        'the export plays back',
        playback.width > 0 && playback.height > 0 && playback.duration > 0.5,
        `${playback.width}×${playback.height}, ${playback.duration.toFixed(1)}s`,
      )
    }
  }

  await finish(context, errors, outDir)
}

async function finish(
  context: import('playwright').BrowserContext,
  errors: string[],
  outDir: string,
) {
  console.log('\nConsole')
  // ONNX Runtime routes its native log through `console.error` regardless of
  // severity, so a `[W:onnxruntime` line is a warning wearing the wrong hat.
  const meaningful = errors.filter(
    (message) =>
      !message.includes('Failed to load resource') &&
      !message.includes('favicon') &&
      !message.includes('[W:onnxruntime'),
  )
  check('no console errors', meaningful.length === 0, meaningful.slice(0, 3).join(' | '))

  await context.close()
  console.log(
    `\n${failures === 0 ? GREEN : RED}${checks - failures}/${checks} checks passed${RESET}`,
  )
  console.log(`${DIM}screenshots in ${outDir}${RESET}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Waits for an export to land, and reports a failure as a failure.
 *
 * Waiting only for the success text means a failed export is indistinguishable
 * from a slow one until the timeout expires — and then the message says
 * "timeout", not what actually went wrong. The app already renders the reason;
 * this reads it.
 */
async function waitForExport(page: import('playwright').Page, timeoutMs: number) {
  const outcome = await page
    .waitForFunction(
      () => {
        // Scoped to the action bar, which is where every terminal state renders.
        // Scanning the whole document would let sidebar copy read as an error.
        const bar = document.querySelector('footer')
        const text = bar?.textContent ?? ''
        if (text.includes('Export complete')) return { ok: true, message: '' }
        // Still working: progress, or the photo path's indeterminate label.
        if (text.includes('Rendering') || text.includes('frames') || text.includes('Starting…')) {
          return null
        }
        // Anything else in the bar with a Dismiss button is the failure state.
        if (bar?.querySelector('button')?.textContent?.includes('Dismiss')) {
          return { ok: false, message: text.replace('Dismiss', '').trim() }
        }
        return null
      },
      undefined,
      { timeout: timeoutMs, polling: 1000 },
    )
    .then((handle) => handle.jsonValue() as Promise<{ ok: boolean; message: string }>)
    .catch(() => ({ ok: false, message: 'timed out' }))
  return outcome
}

/**
 * Reads the finished-export download link and measures what it points at.
 *
 * The blob URL is the file — there is no server copy to inspect — so the size
 * is read back through `fetch` inside the page.
 */
async function describeDownload(page: import('playwright').Page) {
  const link = page.getByRole('link', { name: 'Save' })
  const url = (await link.getAttribute('href')) ?? ''
  const name = (await link.getAttribute('download')) ?? ''
  const bytes = url.startsWith('blob:')
    ? await page.evaluate(async (href: string) => (await (await fetch(href)).blob()).size, url)
    : 0
  return { url, name, bytes }
}

/**
 * Waits out the install, printing the app's own progress line as it moves.
 *
 * Reporting progress rather than just waiting is the difference between "this
 * is slow" and "this is stuck", and the two need different fixes.
 */
async function waitForInstall(page: import('playwright').Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const done = await page
      .getByText('Everything runs on this device')
      .isVisible()
      .catch(() => false)
    if (done) {
      console.log(`  ${DIM}install finished${RESET}`)
      return true
    }
    const line = await page
      .evaluate(() => {
        const match = document.body.innerText.match(/([\d.]+ [kMG]?B of [\d.]+ [kMG]?B)/)
        return match ? match[1] : ''
      })
      .catch(() => '')
    if (line && line !== last) {
      last = line
      console.log(`  ${DIM}${line}${RESET}`)
    }
    await page.waitForTimeout(3000)
  }
  return false
}

/**
 * A CORS-enabled, range-capable static server for the model directory.
 *
 * Range support is not incidental: it is what the store's resume path uses, so
 * a server without it would quietly skip that branch.
 */
async function serveModels(directory: string): Promise<string> {
  const { createServer } = await import('node:http')
  const { createReadStream, statSync } = await import('node:fs')

  const server = createServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\//, '').split('?')[0]
    const path = join(directory, name)
    if (!MODEL_FILES.includes(name) || !existsSync(path)) {
      response.writeHead(404).end()
      return
    }
    const size = statSync(path).size
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    }

    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : size - 1
      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      })
      createReadStream(path, { start, end }).pipe(response)
      return
    }

    response.writeHead(200, { ...headers, 'Content-Length': String(size) })
    createReadStream(path).pipe(response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not bind a port')
  server.unref()
  return `http://127.0.0.1:${address.port}`
}

main().catch((error) => {
  console.error(`\n${RED}smoke run failed${RESET}`, error)
  process.exit(1)
})
