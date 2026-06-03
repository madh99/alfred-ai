import { Writable } from 'node:stream';
import {
  createWriteStream,
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  symlinkSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';

export interface RotatingFileStreamOptions {
  /** Base file path. Used as symlink target. Daily files are written as `<dir>/<basename>.<YYYY-MM-DD>.<N>.log`. */
  filePath: string;
  /** Max bytes per file before size-rotation bumps the index. */
  maxSize: number;
  /** Total files to keep (oldest deleted by mtime). */
  maxFiles: number;
  /** If true, maintain a symlink at `filePath` pointing to the active rotated file. */
  symlink: boolean;
  /**
   * Time provider — injectable for tests. Returns current epoch ms.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Drop-in replacement for `pino-roll` that runs in the main thread.
 *
 * Why: pino-roll v2/v4 schedule midnight rotation via setTimeout inside the
 * transport worker; if a log write hits the stream while rotation is closing
 * it, the worker silently corrupts the logger state, causing alfred to stop
 * at exactly XX:00:00.0XX. We hit this 3+ times (24.05, 25.05, 03.06.2026).
 *
 * This stream rotates synchronously inside _write: every write checks the
 * date string and the on-disk size before writing. There is no concurrent
 * timer, so writes and rotation can never race.
 */
export class RotatingFileStream extends Writable {
  private readonly opts: Required<Omit<RotatingFileStreamOptions, 'now'>> & { now: () => number };
  private writeStream: WriteStream | null = null;
  private currentPath = '';
  private currentDate = '';
  private currentIndex = 1;
  private currentSize = 0;
  private rotating = false;
  private pending: Array<{ chunk: Buffer; cb: (err?: Error | null) => void }> = [];
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(options: RotatingFileStreamOptions) {
    super({ decodeStrings: true });
    this.opts = {
      filePath: isAbsolute(options.filePath) ? options.filePath : resolve(options.filePath),
      maxSize: options.maxSize,
      maxFiles: options.maxFiles,
      symlink: options.symlink,
      now: options.now ?? Date.now,
    };
    mkdirSync(dirname(this.opts.filePath), { recursive: true });
    this.openInitialStream();
    this.scheduleRetention();
  }

  private dateString(): string {
    const d = new Date(this.opts.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private fileBaseName(): string {
    const b = basename(this.opts.filePath);
    return b.endsWith('.log') ? b.slice(0, -4) : b;
  }

  private buildPath(date: string, index: number): string {
    return join(dirname(this.opts.filePath), `${this.fileBaseName()}.${date}.${index}.log`);
  }

  private fileSize(p: string): number {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  }

  /**
   * On startup, find the highest existing index for today and resume writing
   * to it (or bump to the next index if the current one is already at maxSize).
   */
  private openInitialStream(): void {
    this.currentDate = this.dateString();
    let index = 1;
    while (true) {
      const path = this.buildPath(this.currentDate, index);
      if (!existsSync(path)) break;
      if (this.fileSize(path) >= this.opts.maxSize) {
        index++;
        continue;
      }
      break;
    }
    this.currentIndex = index;
    this.currentPath = this.buildPath(this.currentDate, index);
    this.currentSize = this.fileSize(this.currentPath);
    this.writeStream = this.createStream(this.currentPath);
    this.updateSymlink();
  }

  private createStream(path: string): WriteStream {
    const s = createWriteStream(path, { flags: 'a' });
    s.on('error', (err) => {
      // Never throw out of the stream — that would surface as an unhandled
      // 'error' event and kill the process. Write to console.error so an
      // operator can see disk problems without taking alfred down.
      try {
        process.stderr.write(`[logger] write stream error on ${path}: ${(err as Error).message}\n`);
      } catch {
        /* nothing more we can do */
      }
    });
    return s;
  }

  private updateSymlink(): void {
    if (!this.opts.symlink) return;
    try {
      try { unlinkSync(this.opts.filePath); } catch { /* not present */ }
      symlinkSync(basename(this.currentPath), this.opts.filePath);
    } catch {
      /* symlinks may fail on NTFS without admin — non-fatal */
    }
  }

  private needsRotation(chunkLen: number): 'day' | 'size' | null {
    const today = this.dateString();
    if (today !== this.currentDate) return 'day';
    if (this.currentSize + chunkLen > this.opts.maxSize) return 'size';
    return null;
  }

  private rotate(reason: 'day' | 'size', done: (err?: Error | null) => void): void {
    this.rotating = true;
    const closeOld = (cb: (err?: Error | null) => void): void => {
      if (!this.writeStream) return cb();
      const old = this.writeStream;
      this.writeStream = null;
      old.end(cb);
    };
    closeOld(() => {
      try {
        if (reason === 'day') {
          this.currentDate = this.dateString();
          this.currentIndex = 1;
        } else {
          this.currentIndex += 1;
        }
        this.currentPath = this.buildPath(this.currentDate, this.currentIndex);
        this.currentSize = this.fileSize(this.currentPath);
        this.writeStream = this.createStream(this.currentPath);
        this.updateSymlink();
      } catch (err) {
        this.rotating = false;
        return done(err as Error);
      }
      this.rotating = false;
      this.runRetention();
      // Drain pending writes that arrived during rotation.
      const buffered = this.pending;
      this.pending = [];
      const drainNext = (): void => {
        const next = buffered.shift();
        if (!next) return done();
        this.doWrite(next.chunk, (err) => {
          next.cb(err ?? null);
          drainNext();
        });
      };
      drainNext();
    });
  }

  private doWrite(chunk: Buffer, cb: (err?: Error | null) => void): void {
    const reason = this.needsRotation(chunk.length);
    if (reason) {
      this.pending.push({ chunk, cb });
      if (!this.rotating) {
        this.rotate(reason, (err) => {
          if (err) {
            try { process.stderr.write(`[logger] rotation failed: ${err.message}\n`); } catch { /* */ }
          }
        });
      }
      return;
    }
    if (!this.writeStream) {
      // Edge: stream closed mid-flight. Try to reopen.
      this.writeStream = this.createStream(this.currentPath);
    }
    const ok = this.writeStream.write(chunk, (err) => {
      if (!err) this.currentSize += chunk.length;
      cb(err ?? null);
    });
    if (!ok) {
      // Backpressure — caller's callback is invoked via the write() callback.
    }
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.rotating) {
      this.pending.push({ chunk: buf, cb: callback });
      return;
    }
    this.doWrite(buf, callback);
  }

  override _destroy(err: Error | null, callback: (e?: Error | null) => void): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.writeStream) {
      const s = this.writeStream;
      this.writeStream = null;
      s.end(() => callback(err));
    } else {
      callback(err);
    }
  }

  private scheduleRetention(): void {
    this.retentionTimer = setInterval(() => this.runRetention(), 6 * 3600 * 1000);
    this.retentionTimer.unref();
    setImmediate(() => this.runRetention());
  }

  private runRetention(): void {
    try {
      const dir = dirname(this.opts.filePath);
      const baseName = this.fileBaseName();
      const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escaped}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+\\.log$`);
      const entries = readdirSync(dir)
        .filter((f) => pattern.test(f))
        .map((f) => {
          const p = join(dir, f);
          try {
            return { path: p, mtime: statSync(p).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { path: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime);
      const toDelete = entries.slice(this.opts.maxFiles);
      for (const f of toDelete) {
        try { rmSync(f.path); } catch { /* ignore */ }
      }
    } catch {
      /* retention is best-effort */
    }
  }

  /** Internal — for tests. */
  _currentPath(): string { return this.currentPath; }
  /** Internal — for tests. */
  _currentIndex(): number { return this.currentIndex; }
  /** Internal — for tests. */
  _currentDate(): string { return this.currentDate; }
}
