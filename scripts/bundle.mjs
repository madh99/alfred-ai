#!/usr/bin/env node
/**
 * Bundle all @alfred/* workspace packages into a single distributable file.
 * External npm dependencies are kept as imports (resolved from node_modules at runtime).
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to the repo root (one level up from scripts/)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'packages/cli/bundle/index.js');

await build({
  entryPoints: [resolve(root, 'packages/cli/dist/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  sourcemap: false,
  minify: true,
  keepNames: true,
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        // Bundle @alfred/* workspace packages (inline them).
        // Mark everything else (npm packages, node built-ins) as external.
        // Packages to bundle inline (not externalize) — either workspace or small enough
        // Packages to bundle inline (not externalize)
        // NOTE: 'mqtt' CANNOT be inlined — filename conflict (mqtt.ts → mqtt.js confuses esbuild)
        const INLINE_PACKAGES = new Set([
          'sonos',  // Sonos UPnP — required by sonos skill
        ]);

        b.onResolve({ filter: /^[^.]/ }, (args) => {
          if (args.path.startsWith('@alfred/')) {
            return null; // let esbuild resolve & bundle it
          }
          // Don't externalize absolute paths (entry points, resolved files)
          if (args.path.startsWith('/') || /^[a-zA-Z]:/.test(args.path)) {
            return null;
          }
          // Inline specific packages instead of externalizing
          const pkgName = args.path.split('/')[0];
          if (INLINE_PACKAGES.has(pkgName)) {
            return null; // bundle it
          }
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

// Ensure exactly one shebang at the top (source may include one that esbuild preserves)
let code = readFileSync(outfile, 'utf-8');
code = code.replace(/^(#!.*\n)+/, '');
code = '#!/usr/bin/env node\n' + code;
writeFileSync(outfile, code);

console.log('✓ Bundle created: packages/cli/bundle/index.js');

// Copy web UI static files if built
const webUiSrc = resolve(root, 'apps/web/out');
const webUiDest = resolve(root, 'packages/cli/bundle/web-ui');
if (existsSync(webUiSrc)) {
  cpSync(webUiSrc, webUiDest, { recursive: true });
  console.log('✓ Web UI copied to: packages/cli/bundle/web-ui/');
} else {
  console.log('ℹ Web UI not built (apps/web/out/ not found) — skipping');
}
