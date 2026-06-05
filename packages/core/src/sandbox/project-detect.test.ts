import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectType } from './project-detect.js';

describe('detectProjectType v849 compose detection', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alfred-detect-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('hasComposeFile false when no compose.yml exists', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' }, scripts: { dev: 'next dev' } }));
    const r = detectProjectType(dir);
    expect(r.hasComposeFile).toBe(false);
    expect(r.composeFile).toBeUndefined();
  });

  it('detects docker-compose.yml', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  app:\n    image: node');
    const r = detectProjectType(dir);
    expect(r.hasComposeFile).toBe(true);
    expect(r.composeFile).toBe('docker-compose.yml');
  });

  it('detects compose.yaml as fallback', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    writeFileSync(join(dir, 'compose.yaml'), 'services: {}');
    const r = detectProjectType(dir);
    expect(r.hasComposeFile).toBe(true);
    expect(r.composeFile).toBe('compose.yaml');
  });

  it('preserves single-container detection when compose present (NO auto-switch)', () => {
    // Wichtig: hasComposeFile=true ändert NICHT type/devCommand/internalPort.
    // Der Switch passiert erst in sandbox-manager via project.sandboxMode='compose'.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' }, scripts: { dev: 'next dev' } }));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}');
    const r = detectProjectType(dir);
    expect(r.type).toBe('node-next');
    expect(r.internalPort).toBe(3000);
    expect(r.hasDevServer).toBe(true);
    // BUT auch compose erkannt
    expect(r.hasComposeFile).toBe(true);
  });

  it('handles project without package.json but with compose', () => {
    // Reine Service-Stacks (z.B. Postgres + Adminer) ohne Node-App
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres');
    const r = detectProjectType(dir);
    expect(r.type).toBe('unknown');
    expect(r.hasComposeFile).toBe(true);
    expect(r.composeFile).toBe('docker-compose.yml');
  });
});
