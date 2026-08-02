# 🎭 FaceFusion Web

Local-first face swapping for **video & photos**, right in the browser.

🚫 No upload · 🚫 No account · 🚫 No queue — download the models once, then everything runs on your own device.

## 🏗️ Architecture

```
┌────────────┐  postMessage  ┌───────────────────────────────────────┐
│ React page │ ◀───────────▶ │          engine.worker.ts             │
└────────────┘               └───────┬───────────────┬───────────────┘
                                     │               │
                        🧠 ONNX Runtime Web   🎞️ WebCodecs + mediabunny
                        (WebGPU → WASM)       (decode / encode, no FFmpeg)
                                     │
                        📦 Models in OPFS (origin-private storage)

🌐 Network: touched exactly once — the model download. Nothing else, ever.
```

A port of **FaceFusionMac**: XPC → worker · Core ML → WebGPU · AVFoundation → WebCodecs · App Group → OPFS.

## 🔒 Why your media never leaves the device

- 📄 **Static build** — no API routes, no server code that reads anything.
- 1️⃣ The engine worker contains **exactly one `fetch`** (model install only). The swap path has no code that could send a byte anywhere.
- 🗳️ The target file stays a `File` inside the worker; the export comes back as a `Blob` download — it first exists when you save it.

## ⚙️ The pipeline

Per frame, mirroring FaceFusion 3.8.0's `inswapper` path:

| # | Step | How |
|---|------|-----|
| 1 | 🎯 Detect | `yoloface_8n` @ 640×640 → boxes + 5 key points |
| 2 | 📍 Refine | `2dfan4` → 68 landmarks, reduced to 5 (steadier across video) |
| 3 | 📐 Align | least-squares similarity transform onto the ArcFace template |
| 4 | 🧬 Condition | source portrait's ArcFace embedding × `emap` matrix (stored *inside* the inswapper ONNX) |
| 5 | 🔄 Swap | `inswapper_128_fp16` on a 128×128 aligned crop |
| 6 | 🩹 Composite | feathered box mask, inverse warp, paste back |
| 7 | ✨ Restore | optional `gfpgan_1.4` @ 512×512 |

> 🖼️ **Photos** = the same pipeline with one frame. Export re-runs at full resolution; the preview is capped at 1920 px so scrubbing stays fast.

### 👥 Choosing which faces get replaced

| Mode | Behaviour |
|------|-----------|
| *Every face* | Replace all |
| *One face* | Replace the face nearest your tap |
| *Choose* | Matches on **identity**: samples up to 48 frames, clusters ArcFace embeddings into people, keeps only matching faces — survives crossings that defeat position-based picking |

## 🖥️ Browser vs Mac

| Concern | macOS app | Web |
|---|---|---|
| Isolation | XPC service, sandboxed | Module worker |
| Frames across boundary | `IOSurface` by reference | Transferred `ArrayBuffer`; during export, frames never cross |
| Inference | ONNX Runtime → Core ML | ONNX Runtime Web → WebGPU (fallback: threaded WASM) |
| Decode / encode | AVFoundation | WebCodecs + mediabunny |
| Model storage | App Group container | OPFS + `navigator.storage.persist()` |
| Concurrency | 3 frames in flight | Strictly serial — see below |
| Audio | — | Remuxed (bit-identical copy), not re-encoded |

> ⚠️ **Inference is serialised on purpose.** ONNX Runtime Web's WebGPU backend shares one command encoder across sessions — concurrent runs don't fail loudly, they corrupt a frame. `Serializer` in [`src/engine/runtime.ts`](src/engine/runtime.ts) prevents it, and costs nothing: the GPU runs one graph at a time anyway.

## 📦 Models

| Model | Size | Required | Licence |
|---|---|---|---|
| `yoloface_8n` | 12.7 MB | ✅ | GPL-3.0 |
| `arcface_w600k_r50` | 174 MB | ✅ | InsightFace, non-commercial |
| `inswapper_128_fp16` | 278 MB | ✅ | InsightFace, non-commercial |
| `2dfan4` | 98 MB | ➖ | MIT |
| `gfpgan_1.4` | 340 MB | ➖ | Apache-2.0 |

> ⚖️ **The face-swapping models are licensed for non-commercial research use. Only swap faces of people who have agreed to it.**

### 🌐 Why Hugging Face, not GitHub?

The iOS/Mac apps download from the official [FaceFusion GitHub release](https://github.com/facefusion/facefusion-assets/releases). The web app **can't**:

- GitHub's release CDN sends **no `Access-Control-Allow-Origin` header** → browsers block the response ([CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)); a web page simply cannot read those bytes.
- [Hugging Face](https://huggingface.co/facefusion/models-3.0.0) serves the **same files** with CORS + range support.
- Same bytes guaranteed: every download is verified against the SHA-256 digests of the GitHub release, pinned in [`public/models.json`](public/models.json). A mismatch is discarded, not installed.

📥 Downloads stream to a `.partial` file and resume with a `Range` request if interrupted. Every byte is SHA-256-hashed **as it arrives** — no second pass, no full copy in memory (which is what makes a 340 MB model viable on a phone, and why `Sha256` is hand-written instead of the one-shot `crypto.subtle.digest`).

## ✅ Requirements

Checked on load — the app says which one is missing rather than failing obscurely.

| Feature | Used for | Minimum |
|---|---|---|
| Web Workers (module) | the engine | everywhere |
| OPFS | model storage | Chrome 108 · Safari 17 · Firefox 111 |
| WebCodecs | video decode/encode | Chrome 94 · Safari 16.4 · Firefox 130 |
| OffscreenCanvas | frame handling | Chrome 69 · Safari 17 · Firefox 105 |
| WebGPU | fast inference | Chrome 113 · Safari 26 — else WASM |

💾 **Memory:** ~465 MB of weights required, ~900 MB with extras — resident while the engine runs, loaded one model at a time. On phones, skip the optional models (there's a toggle on the first screen).

⏱️ **Speed:** restoration dominates a frame. Turning *Enhance detail* off is the single biggest export speedup.

## 🚀 Running it

```sh
pnpm install          # also copies ONNX Runtime binaries into public/ort/
pnpm dev              # http://localhost:3223
pnpm build && pnpm start
```

The ORT binaries are served from our own origin — that keeps the app single-origin and offline-capable.

## 🧪 Verifying it

| Command | What it proves |
|---|---|
| `pnpm verify:pipeline` | 🧮 The maths — runs the real `src/engine` under Node against ground-truth values from the reference FaceFusion pipeline |
| `pnpm smoke` | 🌐 The browser — drives the running app in Chromium: isolation, OPFS, WebGPU, install, preview, both export paths |

Last local run: **26/26** pipeline checks (output matches the macOS app within 1/255 per pixel) and **21/21** smoke checks, incl. playing the exported MP4 back in a `<video>` element — because *"bytes were written"* and *"the muxing is right"* are different claims.

`smoke` needs the app running (`pnpm build && pnpm start`). It reuses a Chromium profile under `.verify-out/profile` so the 903 MB install happens once; `--fresh` re-exercises the install, `--headed` lets you watch.

## 📁 Layout

```
src/
  engine/      🧮 the pipeline — no browser API, runs in the worker and in Node
  worker/      🔌 model store, media, message protocol (OPFS, WebCodecs, postMessage)
  lib/         🖥️ the page's side: worker client, app state, formatting
  components/  🎨 the interface
tools/         🧪 the two verification harnesses
```

The `engine/` ↔ `worker/` split is what lets the maths be tested against ground truth without a browser in the loop.
