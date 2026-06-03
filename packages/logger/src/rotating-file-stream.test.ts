import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync, rmSync, writeFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingFileStream } from './rotating-file-stream.js';

function waitForWrite(stream: RotatingFileStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

function endStream(stream: RotatingFileStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

describe('RotatingFileStream', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alfred-rfs-'));
    filePath = join(dir, 'app.log');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('writes to daily file with expected naming', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    const s = new RotatingFileStream({ filePath, maxSize: 1024 * 1024, maxFiles: 30, symlink: false, now: () => fixedNow });
    await waitForWrite(s, 'hello\n');
    await endStream(s);
    const files = readdirSync(dir);
    expect(files).toContain('app.2026-03-15.1.log');
    const content = readFileSync(join(dir, 'app.2026-03-15.1.log'), 'utf-8');
    expect(content).toBe('hello\n');
  });

  it('rotates on day change without losing writes', async () => {
    // Use local-noon timestamps to be TZ-agnostic; dateString() uses local date.
    const day1Local = new Date(2026, 2, 15, 12, 0, 0).getTime();
    const day2Local = new Date(2026, 2, 16, 12, 0, 0).getTime();
    let mockNow = day1Local;
    const s = new RotatingFileStream({ filePath, maxSize: 1024 * 1024, maxFiles: 30, symlink: false, now: () => mockNow });
    await waitForWrite(s, 'before-midnight\n');
    mockNow = day2Local;
    await waitForWrite(s, 'after-midnight\n');
    await endStream(s);
    const day1 = readFileSync(join(dir, 'app.2026-03-15.1.log'), 'utf-8');
    const day2 = readFileSync(join(dir, 'app.2026-03-16.1.log'), 'utf-8');
    expect(day1).toBe('before-midnight\n');
    expect(day2).toBe('after-midnight\n');
  });

  it('rotates on size overflow within the same day', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    const s = new RotatingFileStream({ filePath, maxSize: 20, maxFiles: 30, symlink: false, now: () => fixedNow });
    await waitForWrite(s, '1234567890\n');           // 11 bytes — fits
    await waitForWrite(s, 'second-line-longer\n');   // would exceed 20 — triggers size rotate
    await endStream(s);
    expect(existsSync(join(dir, 'app.2026-03-15.1.log'))).toBe(true);
    expect(existsSync(join(dir, 'app.2026-03-15.2.log'))).toBe(true);
    expect(readFileSync(join(dir, 'app.2026-03-15.1.log'), 'utf-8')).toBe('1234567890\n');
    expect(readFileSync(join(dir, 'app.2026-03-15.2.log'), 'utf-8')).toBe('second-line-longer\n');
  });

  it('resumes index when an existing file for today is below maxSize', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    writeFileSync(join(dir, 'app.2026-03-15.1.log'), 'existing\n');
    const s = new RotatingFileStream({ filePath, maxSize: 1024, maxFiles: 30, symlink: false, now: () => fixedNow });
    await waitForWrite(s, 'appended\n');
    await endStream(s);
    expect(readFileSync(join(dir, 'app.2026-03-15.1.log'), 'utf-8')).toBe('existing\nappended\n');
  });

  it('skips to next index when existing file for today is at maxSize', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    writeFileSync(join(dir, 'app.2026-03-15.1.log'), 'A'.repeat(20));
    const s = new RotatingFileStream({ filePath, maxSize: 20, maxFiles: 30, symlink: false, now: () => fixedNow });
    await waitForWrite(s, 'new\n');
    await endStream(s);
    expect(readFileSync(join(dir, 'app.2026-03-15.2.log'), 'utf-8')).toBe('new\n');
  });

  it('respects retention (maxFiles)', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    // Pre-create 5 old files, vary mtime
    for (let i = 1; i <= 5; i++) {
      const p = join(dir, `app.2026-03-${10 + i}.1.log`);
      writeFileSync(p, 'x');
      // Different mtime so we can predict deletion order
      const past = new Date(fixedNow - (10 - i) * 86400 * 1000);
      const { utimesSync } = require('node:fs');
      utimesSync(p, past, past);
    }
    const s = new RotatingFileStream({ filePath, maxSize: 1024, maxFiles: 3, symlink: false, now: () => fixedNow });
    await waitForWrite(s, 'today\n');
    // Wait one tick for setImmediate retention
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await endStream(s);
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.log'));
    expect(remaining.length).toBeLessThanOrEqual(3);
  });

  it('handles many sequential writes without race', async () => {
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    const s = new RotatingFileStream({ filePath, maxSize: 50, maxFiles: 100, symlink: false, now: () => fixedNow });
    const lines: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(waitForWrite(s, `line-${i}\n`));
    }
    await Promise.all(lines);
    await endStream(s);
    // Concatenate all rotated files (in index order) — must equal expected sequence
    const files = readdirSync(dir)
      .filter((f) => /^app\.2026-03-15\.\d+\.log$/.test(f))
      .sort((a, b) => {
        const ai = Number(a.match(/\.(\d+)\.log$/)![1]);
        const bi = Number(b.match(/\.(\d+)\.log$/)![1]);
        return ai - bi;
      });
    const concatenated = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('');
    const expected = Array.from({ length: 100 }, (_, i) => `line-${i}\n`).join('');
    expect(concatenated).toBe(expected);
  });

  it('creates symlink pointing at the active file when enabled', async () => {
    if (process.platform === 'win32') {
      // Symlinks require admin on Windows; skip without failing the suite.
      return;
    }
    const fixedNow = new Date(2026, 2, 15, 12, 0, 0).getTime();
    const s = new RotatingFileStream({ filePath, maxSize: 1024, maxFiles: 30, symlink: true, now: () => fixedNow });
    await waitForWrite(s, 'hello\n');
    await endStream(s);
    expect(existsSync(filePath)).toBe(true);
    const target = readlinkSync(filePath);
    expect(target).toBe('app.2026-03-15.1.log');
  });
});
