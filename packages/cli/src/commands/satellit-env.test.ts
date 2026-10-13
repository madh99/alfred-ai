import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envSchluessel } from './satellit-env.js';

describe('v1443 B15 Umgebungs-Schlüssel am Gerät', () => {
  it('nur Namen aus .env.example und Quelltext; .env und node_modules werden nicht gelesen', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'env-'));
    writeFileSync(path.join(d, '.env.example'), 'DATABASE_URL=\n# Kommentar\nPORT=3000\n');
    writeFileSync(path.join(d, '.env'), 'GEHEIM_NUR_LOKAL=wert123\n');
    mkdirSync(path.join(d, 'src'));
    writeFileSync(path.join(d, 'src', 'app.ts'), 'const k = process.env.API_KEY; const p = process.env["PORT"];');
    writeFileSync(path.join(d, 'src', 'cfg.py'), 'import os\nx = os.getenv("PY_KEY")');
    mkdirSync(path.join(d, 'node_modules'));
    writeFileSync(path.join(d, 'node_modules', 'x.js'), 'process.env.FREMD');
    const k = envSchluessel(d);
    expect(k.map(x => x.key)).toEqual(['API_KEY', 'DATABASE_URL', 'PORT', 'PY_KEY']);
    expect(k.find(x => x.key === 'PORT')!.sources).toEqual(['.env.example', 'src/app.ts']);
    expect(JSON.stringify(k)).not.toMatch(/wert123|GEHEIM_NUR_LOKAL|3000/);
  });
});
