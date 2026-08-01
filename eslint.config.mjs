import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // The ONNX Runtime bundles, copied in by `tools/copy-ort-assets.mjs`.
    // Minified third-party output; linting it produces hundreds of findings
    // about code we neither wrote nor can change.
    'public/ort/**',
    '.verify-out/**',
  ]),
])

export default eslintConfig
