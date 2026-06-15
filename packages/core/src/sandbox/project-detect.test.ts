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

describe('detectProjectType v901 multi-stack (non-node)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alfred-detect-nn-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('Django via manage.py → python-312-Image, runserver, migrate', () => {
    writeFileSync(join(dir, 'manage.py'), '# django');
    const r = detectProjectType(dir);
    expect(r.type).toBe('python-django');
    expect(r.image).toBe('alfred-sandbox:python-312');
    expect(r.internalPort).toBe(8000);
    expect(r.devCommand.join(' ')).toContain('manage.py runserver');
    expect(r.dbMigrateCommand).toContain('migrate');
    expect(r.setupCommand?.[0]).toContain('pip install');
    expect(r.hasDevServer).toBe(true);
  });

  it('Laravel via artisan → php-83-Image, artisan serve', () => {
    writeFileSync(join(dir, 'artisan'), '#!/usr/bin/env php');
    const r = detectProjectType(dir);
    expect(r.type).toBe('php-laravel');
    expect(r.image).toBe('alfred-sandbox:php-83');
    expect(r.devCommand.join(' ')).toContain('artisan serve');
    expect(r.setupCommand?.[0]).toContain('composer install');
  });

  it('Rails via Gemfile+config.ru → ruby-33-Image', () => {
    writeFileSync(join(dir, 'Gemfile'), "gem 'rails'");
    writeFileSync(join(dir, 'config.ru'), 'run Rails.application');
    const r = detectProjectType(dir);
    expect(r.type).toBe('ruby-rails');
    expect(r.image).toBe('alfred-sandbox:ruby-33');
    expect(r.internalPort).toBe(3000);
  });

  it('Go via go.mod → go-122-Image', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22');
    const r = detectProjectType(dir);
    expect(r.type).toBe('go');
    expect(r.image).toBe('alfred-sandbox:go-122');
    expect(r.internalPort).toBe(8080);
    expect(r.devCommand.join(' ')).toBe('go run .');
  });

  it('FastAPI via requirements.txt mit fastapi → python-fastapi (uvicorn)', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi\nuvicorn');
    const r = detectProjectType(dir);
    expect(r.type).toBe('python-fastapi');
    expect(r.devCommand.join(' ')).toContain('uvicorn');
  });

  it('Node-Framework hat Vorrang vor go.mod im selben Repo', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' }, scripts: { dev: 'next dev' } }));
    writeFileSync(join(dir, 'go.mod'), 'module x');
    const r = detectProjectType(dir);
    expect(r.type).toBe('node-next');
  });
});
