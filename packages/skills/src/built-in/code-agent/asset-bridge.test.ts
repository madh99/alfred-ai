import { describe, it, expect } from 'vitest';
import { findAssetKeys, stageAssetsForProject } from './asset-bridge.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileStore } from '@alfred/storage';

function makeStubStore(data: Record<string, Buffer>): FileStore {
  return {
    backend: 'stub',
    async read(key: string): Promise<Buffer> {
      if (!(key in data)) throw new Error(`stub: key not found: ${key}`);
      return data[key];
    },
    async save() { throw new Error('not impl'); },
    async list() { return []; },
    async delete() { return false; },
    async exists(key: string) { return key in data; },
  };
}

describe('findAssetKeys', () => {
  it('finds file-store-style keys in goal text', () => {
    const text = `Das Logo liegt unter 5060785419/2026-05-19T14-25-02-603Z_file_92.MP4 — bitte verwenden.`;
    const keys = findAssetKeys(text);
    expect(keys).toEqual(['5060785419/2026-05-19T14-25-02-603Z_file_92.MP4']);
  });

  it('finds multiple keys', () => {
    const text = `Files: 1234/2026-01-01T00-00-00-000Z_a.png and 5678/2026-02-02T01-01-01-001Z_b.jpg`;
    const keys = findAssetKeys(text);
    expect(keys.length).toBe(2);
  });

  it('dedupes identical keys', () => {
    const k = '1234/2026-01-01T00-00-00-000Z_a.png';
    const text = `${k} and ${k} again`;
    expect(findAssetKeys(text)).toEqual([k]);
  });

  it('does not match URLs or plain paths', () => {
    const text = 'http://example.com/x.png and /var/log/foo.log and node_modules/foo';
    expect(findAssetKeys(text)).toEqual([]);
  });

  it('returns empty for text without keys', () => {
    expect(findAssetKeys('just a normal sentence')).toEqual([]);
  });
});

describe('stageAssetsForProject', () => {
  it('writes referenced assets to <cwd>/uploads/ and rewrites the goal', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-asset-bridge-'));
    try {
      const logoData = Buffer.from('fake-mp4-bytes');
      const store = makeStubStore({
        '5060785419/2026-05-19T14-25-02-603Z_logo.MP4': logoData,
      });
      const goal = 'Logo: 5060785419/2026-05-19T14-25-02-603Z_logo.MP4 verwenden.';
      const result = await stageAssetsForProject(goal, tmp, store);
      expect(result.staged.length).toBe(1);
      expect(result.staged[0].localFileName).toBe('logo.MP4');
      expect(result.staged[0].relativePath).toBe('uploads/logo.MP4');
      expect(existsSync(path.join(tmp, 'uploads', 'logo.MP4'))).toBe(true);
      expect(readFileSync(path.join(tmp, 'uploads', 'logo.MP4'))).toEqual(logoData);
      expect(result.rewrittenGoal).toContain('uploads/logo.MP4');
      expect(result.rewrittenGoal).not.toContain('2026-05-19T14-25-02-603Z_logo.MP4');
      expect(result.rewrittenGoal).toContain('Angehängte Dateien wurden bereits unter');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('records errors for missing keys without throwing', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-asset-bridge-'));
    try {
      const store = makeStubStore({});
      const key = '1234/2026-01-01T00-00-00-000Z_missing.png';
      const result = await stageAssetsForProject(`Use ${key}`, tmp, store);
      expect(result.staged.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].key).toBe(key);
      expect(result.rewrittenGoal).toContain('konnten nicht geladen werden');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('handles collisions in cleaned filenames', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-asset-bridge-'));
    try {
      const store = makeStubStore({
        '1234/2026-01-01T00-00-00-000Z_logo.png': Buffer.from('a'),
        '1234/2026-02-02T00-00-00-000Z_logo.png': Buffer.from('b'),
      });
      const goal = `First: 1234/2026-01-01T00-00-00-000Z_logo.png, Second: 1234/2026-02-02T00-00-00-000Z_logo.png`;
      const result = await stageAssetsForProject(goal, tmp, store);
      expect(result.staged.length).toBe(2);
      const names = result.staged.map(a => a.localFileName).sort();
      expect(names).toContain('logo.png');
      expect(names).toContain('logo_2.png');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('returns unchanged goal when no keys found', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-asset-bridge-'));
    try {
      const store = makeStubStore({});
      const goal = 'A plain goal with no file references.';
      const result = await stageAssetsForProject(goal, tmp, store);
      expect(result.staged.length).toBe(0);
      expect(result.errors.length).toBe(0);
      expect(result.rewrittenGoal).toBe(goal);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
