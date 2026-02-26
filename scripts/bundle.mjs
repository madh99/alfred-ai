#!/usr/bin/env node
/**
 * Bundle all @alfred/* workspace packages into a single distributable file.
 * External npm dependencies are kept as imports (resolved from node_modules at runtime).
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const outfile = 'packages/cli/bundle/index.js';

await build({
  entryPoints: ['packages/cli/dist/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  sourcemap: false,
  minify: false,
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        // Bundle @alfred/* workspace packages (inline them).
        // Mark everything else (npm packages, node built-ins) as external.
        b.onResolve({ filter: /^[^.]/ }, (args) => {
          if (args.path.startsWith('@alfred/')) {
            return null; // let esbuild resolve & bundle it
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
