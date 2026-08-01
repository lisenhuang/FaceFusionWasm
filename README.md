# FaceFusion Web

A local-first face-swapping app for video and for photos, in the browser. No
upload, no queue, no account — open the page, download the models once, and
everything after that runs on your own device.

```
React page  ──postMessage──▶  engine.worker.ts  ──▶  ONNX Runtime Web  ──▶  WebGPU
   │                               │
   │                               ├── models in OPFS (origin-private storage)
   │                               └── WebCodecs decode / encode  (replaces FFmpeg)
   └── the only thing that ever touches the network is the one-time model download
```

This is a port of FaceFusionMac, and it keeps that app's
interface and its pipeline. What changed is the substrate: XPC became a worker,
Core ML became WebGPU, AVFoundation became WebCodecs, and the App Group container
became the Origin Private File System.

## Why your media never leaves the device

There is nothing to leave to. The app has no API routes, no server actions and no
server components that read anything — `next build` emits static pages, and the
only server role is handing those files to the browser.

Inside the browser the confinement is structural rather than promised:

- The engine worker contains exactly one `fetch`, in `ModelStore`, reachable only
  through the `installModels` message. Nothing on the swap path can send a byte
  anywhere, because nothing on the swap path has the code to.
- The target file is handed to the worker as a `File` and read with `BlobSource`.
  It is never turned into a URL, never uploaded, never copied outside the worker.
- Export output arrives back as a `Blob` and is offered as a download. The file
  first exists at the moment you save it.

The macOS app could go further and have the sandbox *enforce* this — its engine
holds no network entitlement at all. A web page has no equivalent, so the
guarantee here rests on the code being small enough to check. It is: one `fetch`,
one manifest, five URLs.

## The pipeline

Per frame, mirroring FaceFusion 3.8.0's `inswapper` path:

1. **Detect** — `yoloface_8n` on a 640×640 canvas → boxes + 5 key points.
2. **Refine** — `2dfan4` → 68 landmarks, reduced back to 5. Steadier than the
   detector's own points across a video.
3. **Align** — least-squares similarity transform onto the `arcface_128`
   template. This is the closed-form 2-D Procrustes solution, which is what
   OpenCV's `estimateAffinePartial2D` converges to.
4. **Condition** — the source portrait's ArcFace embedding, projected through the
   512×512 `emap` matrix stored as the last initializer *inside* the inswapper
   ONNX file. Note the divisor is the magnitude of the **original** embedding,
   not of the projected result.
5. **Swap** — `inswapper_128_fp16` on a 128×128 aligned crop.
6. **Composite** — feathered box mask, inverse warp, paste back.
7. **Restore** — optional `gfpgan_1.4` at 512×512 over the composited frame.

`emap` is read with a small purpose-built ONNX protobuf walker
([`onnx-initializer.ts`](src/engine/onnx-initializer.ts)) — ONNX Runtime offers no
way to read a graph initializer back out, and the walker skips the hundreds of
megabytes of weights rather than decoding them.

### One deliberate divergence

Aligning a 1024 px portrait to ArcFace's 112 px input is a ~6.7× reduction. The
reference samples that with a bare bilinear tap, which aliases badly — single
pixels differ from a correctly prefiltered crop by up to 183/255, and in video
that shows up as shimmer. `RGBAImage.warped` box-reduces before sampling whenever
a warp shrinks by more than half. This is inherited from the macOS port, where it
moved agreement with the reference identity vector from 0.956 to 0.966 cosine.

### Photos

A photo target is the same pipeline with one frame. It differs only at the edges:
there is no timeline to scrub, the codec toggle gives way to a PNG write, and the
result comes out of `convertToBlob` instead of an encoder.

The export re-runs the swap rather than saving what the preview produced, so the
file always matches the settings as they stand when Export is pressed — and it
runs at the image's own resolution, whereas the preview is capped at 1920 px so
that scrubbing stays responsive.

### Choosing which faces get replaced

*Every face* and *One face* are geometric: replace all of them, or replace the one
nearest a point you tapped. *Choose* is not, and the difference matters for video.

Faces are re-detected independently on every frame, and detection order is
left-to-right within a single frame — so "the second face" stops naming the same
person the moment two people cross, and a fixed point stops naming anyone as soon
as the subject moves. Neither survives a clip.

So *Choose* matches on identity instead. The worker samples up to 48 frames across
the duration, takes an ArcFace embedding per face, and groups those vectors into
people by cosine distance — a running mean per person, so one badly-timed frame
cannot define someone for the rest of the video. Ticking a person sends their
512-d identity to the pipeline, which then keeps only the detections within
`matchDistance` of one of them. This is FaceFusion's `reference` face-selector
mode, arrived at for the same reason.

Two consequences worth knowing:

- The reference set is pushed once per change, not per frame, and carries a
  generation number. A swap naming a generation the engine no longer holds is
  refused rather than run against a stale set — silently swapping the wrong person
  is a worse failure than a visible error.
- Sampling can miss someone who is only briefly on screen. Tapping their face in
  the preview adds them, which is why that gesture toggles rather than re-selects
  while *Choose* is active.

## Where the browser differs from the Mac

| Concern | macOS app | Here |
|---|---|---|
| Isolation | XPC service, separately sandboxed | Module worker |
| Frames across the boundary | `IOSurface`, passed by reference | Transferred `ArrayBuffer`; during an export, frames never cross at all |
| Inference | ONNX Runtime → Core ML → ANE/GPU | ONNX Runtime Web → WebGPU, falling back to threaded WASM |
| Decode / encode | AVFoundation → VideoToolbox | WebCodecs, demuxed and muxed by mediabunny |
| Model storage | App Group container | OPFS, with `navigator.storage.persist()` requested |
| Export destination | `NSSavePanel` | A download |
| Concurrency | 3 frames in flight, one lock per session | Strictly one inference at a time |

Three of those are worth expanding on.

**Inference is serialised, and that is not a shortcut.** The macOS engine keeps
three frames inside the engine at once and measures 1.8× for it, because its four
`ORTSession`s are genuinely independent. ONNX Runtime Web's WebGPU backend is not:
one command encoder and one program cache serve every session in the module.
Overlapping runs there does not fail loudly — it corrupts a frame. `Serializer` in
[`src/engine/runtime.ts`](src/engine/runtime.ts) is what prevents it, and it costs
nothing real, because the GPU was executing one graph at a time either way.

**Frames during an export never leave the worker.** The worker holds the `File`
itself, so decode, swap and encode all happen on one thread with no `postMessage`
in the loop. Only the preview — one frame at a time, on demand — crosses back.

**Audio is remuxed, not re-encoded.** The original audio packets are copied
straight into the output MP4, so the track is bit-identical and costs almost
nothing. Audio a browser can decode but MP4 cannot hold is dropped, and the export
says so rather than coming out silently mute.

## Models

Fetched from the FaceFusion model release, mirrored on Hugging Face, and verified
against the SHA-256 digests in [`public/models.json`](public/models.json) before
installation. A mismatch is discarded, not installed.

| Model | Size | Required | Licence |
|---|---|---|---|
| `yoloface_8n` | 12.7 MB | yes | GPL-3.0 |
| `arcface_w600k_r50` | 174 MB | yes | InsightFace, non-commercial |
| `inswapper_128_fp16` | 278 MB | yes | InsightFace, non-commercial |
| `2dfan4` | 98 MB | no | MIT |
| `gfpgan_1.4` | 340 MB | no | Apache-2.0 |

**The face-swapping models are licensed for non-commercial research use. Only swap
faces of people who have agreed to it.**

Hugging Face rather than the GitHub release the macOS app uses, for a reason that
is not a preference: GitHub's release CDN sends no `Access-Control-Allow-Origin`
header, so a browser cannot read those bytes at all. Hugging Face serves the same
files — the digests above match byte for byte — with CORS and range support.

Downloads stream to a `.partial` file and resume with a `Range` request if
interrupted. Every byte is hashed **as it arrives**, so verification costs no
second pass and no second copy of the file — which is what makes a 340 MB model
viable on a phone. That is also why `Sha256` is hand-written rather than
`crypto.subtle.digest`: the latter is one-shot and would need the whole file in
memory at once.

## Requirements

The app checks these on load and says which one is missing rather than failing
obscurely.

| Feature | Used for | Minimum |
|---|---|---|
| Web Workers (module) | the engine | everywhere |
| OPFS | model storage | Chrome 108, Safari 17, Firefox 111 |
| WebCodecs | video decode and encode | Chrome 94, Safari 16.4, Firefox 130 |
| OffscreenCanvas | frame handling in the worker | Chrome 69, Safari 17, Firefox 105 |
| WebGPU | fast inference | Chrome 113, Safari 26; otherwise WASM |

Cross-origin isolation (`COOP` + `COEP`) is set in
[`next.config.ts`](next.config.ts). It is not required — WebGPU does not need it —
but without it `SharedArrayBuffer` is unavailable and the WASM fallback drops to a
single thread. `credentialless` rather than `require-corp`, because model
downloads are CORS-mode fetches to a host that sends no CORP header.

### Memory

The required models are ~465 MB of weights, ~900 MB with both optional ones. They
are resident in the backend's heap for as long as the engine is up. Desktops are
comfortable; on a phone, installing without the quality extras is the difference
between working and not, which is why that toggle exists on the first screen.

They are also read one at a time, straight from OPFS into the session builder, so
the peak is one model plus the runtime's copy of it rather than all five at once
— see `SwapPipeline.prepare`. Reading them all up front is the obvious way to
write it and roughly doubles the high-water mark.

### Speed

Restoration dominates. On the macOS app's own numbers the enhancer is 280 ms of a
465 ms frame, and the same holds here: turning *Enhance detail* off is the single
largest thing a user can do about export time. The export bar reports frames per
second and time remaining rather than a bare spinner, because on a long clip the
honest answer is minutes and a progress bar that says so is better than one that
does not.

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm build && pnpm start
```

`pnpm install` copies the ONNX Runtime binaries into `public/ort/` — they are
loaded at runtime by a path the runtime computes for itself, so they cannot go
through the bundler, and serving them from our own origin is what keeps the app
single-origin and offline-capable.

## Verifying it

Two harnesses, covering two different things.

```sh
pnpm verify:pipeline     # the maths, against ground truth, in Node
pnpm smoke               # the browser, against a real install, in Chromium
```

**`verify:pipeline`** runs `src/engine` — the same modules the worker loads,
unmodified — against the real ONNX models under `onnxruntime-node`, and checks
them against values captured from the reference FaceFusion pipeline: the first six
entries of `emap`, the detector's five key points on the reference portrait, and
the composited frame against the macOS app's own output. Nothing in it is a
re-implementation for testing; `src/engine` imports no browser API precisely so
that this is possible.

Last run on this machine, against the macOS app's model container:

```
✓ emap head matches reference           [0.124847, -0.008458, 0.080384…]
✓ key points match the reference        worst 0.07px
✓ conditioning is near unit length      ‖v‖ = 0.8929
✓ matches the macOS app output          mean |Δ| 0.94 / 255
26/26 checks passed
```

That last line is the one that matters: the same portrait, run through this
TypeScript port under WebAssembly, differs from the shipping macOS app's own
output by under one level out of 255 — through detection, landmark refinement,
alignment, the swap and GFPGAN restoration.

**`smoke`** drives the running app in Chromium and covers everything that only
exists in a browser: cross-origin isolation, OPFS and WebGPU reachable from
inside a worker, both layouts free of horizontal overflow at 390 px, and — given
a local model directory — the real install, the engine starting on WebGPU, a
source face encoded, a preview swap, and both export paths end to end. The
exported MP4 is loaded back into a `<video>` element, because "bytes were
written" and "the muxing is right" are different claims.

```
✓ cross-origin isolated                     wasm threads available: 8
✓ WebGPU adapter available
✓ models installed and verified             903 MB, streamed and hashed in-browser
✓ engine reported a backend                 WebGPU
✓ preview swap completed
✓ the preview canvas fits its container     366×297 in 366×297
✓ produced a PNG                            1.72 MB
✓ the export plays back                     640×338, 10.9s
21/21 checks passed
```

It reuses a Chromium profile under `.verify-out/profile` and skips the install
when the models are still there, which usually makes repeat runs quick — headless
Chromium treats OPFS as best-effort storage and does sometimes clear it between
sessions, so the run detects which screen it is on rather than assuming.
`--fresh` throws the profile away deliberately; `--headed` lets you watch.
Restoration is switched off for the video leg — the photo export already
exercised it, and over a few hundred frames it is the difference between a check
that gets run and one that does not.

Four bugs this found that nothing else would have:

- **Inference was not serialised.** A face scan, a preview and an export could be
  inside ONNX Runtime at the same moment. Its WebGPU backend shares one command
  encoder across sessions, so the overlap did not fail cleanly — it failed a
  frame. `Serializer` in [`src/engine/runtime.ts`](src/engine/runtime.ts) is the
  fix, and the comment there explains why the queue must not be removed.
- **The app jumped to the studio mid-install.** `modelsReady` flips when the
  *required* models land, which is halfway through a download the user was told
  was 903 MB.
- **AAC priming broke the muxer.** MP4 expresses encoder delay as a first audio
  packet with a negative timestamp, which no muxer will accept. Clamping it to
  zero would have "fixed" the error and pushed the audio ~100 ms out of sync; the
  whole timeline is shifted instead.
- **The preview was cropping the frame.** A canvas carries its bitmap as
  intrinsic dimensions, so a percentage height that failed to resolve left the
  element at 1024 px tall inside a 300 px box, and the container quietly clipped
  it. It reads as a badly chosen crop, not as a layout bug — which is why the
  check that now guards it measures the box instead of taking a screenshot.

## Layout

```
src/
  engine/     the pipeline. No browser API — runs in the worker and in Node.
  worker/     the engine worker: model store, media, and the message protocol.
  lib/        the page's side: the worker client, app state, formatting.
  components/ the interface.
tools/        the two verification harnesses.
```

The split between `engine/` and `worker/` is the one that matters. `engine/`
knows about tensors and pixels; `worker/` knows about OPFS, WebCodecs and
`postMessage`. Keeping the first free of the second is what lets the maths be
tested against ground truth without a browser in the loop.
