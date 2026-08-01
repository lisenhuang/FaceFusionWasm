// Copies the ONNX Runtime Web binaries into public/ort/ so they are served
// from our own origin.
//
// They cannot be imported through the bundler: the .wasm files are loaded at
// runtime by a path the runtime computes for itself, and pnpm's symlinked
// node_modules puts them outside anything Next.js would serve. Copying is also
// what keeps the app single-origin — nothing is fetched from a CDN.
import { cp, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

async function main() {
  let from
  try {
    from = join(dirname(require.resolve('onnxruntime-web')), '..', 'dist')
  } catch {
    console.warn('[ort] onnxruntime-web not installed yet; skipping asset copy')
    return
  }
  const to = join(process.cwd(), 'public', 'ort')
  await mkdir(to, { recursive: true })

  const wanted = (name) =>
    (name.endsWith('.wasm') || name.endsWith('.mjs')) && !name.includes('.min.')

  const names = (await readdir(from)).filter(wanted)
  await Promise.all(names.map((name) => cp(join(from, name), join(to, name))))
  console.log(`[ort] copied ${names.length} runtime file(s) to public/ort`)
}

main().catch((error) => {
  console.error('[ort] copy failed:', error)
  process.exitCode = 1
})
