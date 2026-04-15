import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function getVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../package.json', '../../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, rel), 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* fallback */ }
  return '0.0.0';
}
