import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: 'dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
