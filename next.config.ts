import type { NextConfig } from 'next'

/**
 * There is no server here beyond a static file host.
 *
 * The app has no API routes, no server actions and no server components that
 * read anything: every byte of a user's media is decoded, swapped and encoded
 * inside their own browser. What the config below does is grant the page the two
 * browser capabilities that work needs.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Cross-origin isolation. SharedArrayBuffer — and therefore
          // multi-threaded WebAssembly — is gated behind it, and on the CPU
          // backend that is the difference between one core and all of them.
          // WebGPU does not need it, so a host that cannot set these still
          // works; it just falls back to a single WASM thread.
          //
          // `credentialless` rather than `require-corp`: model downloads are
          // CORS-mode fetches to Hugging Face, which sends no CORP header.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },

          // Nothing here is worth framing, sniffing or leaking a referrer for.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        // The runtime binaries are content-addressed by version and never
        // change under a given build.
        source: '/ort/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },

  // Turbopack is the Next 16 default and resolves `onnxruntime-web`'s browser
  // build without the Node fallbacks webpack needed to be told to ignore.
  turbopack: {},
}

export default nextConfig
