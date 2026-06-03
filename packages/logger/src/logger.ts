import pino from 'pino';
import pretty from 'pino-pretty';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RotatingFileStream } from './rotating-file-stream.js';

const redactOpts = {
  paths: [
    '**.apiKey', '**.token', '**.password', '**.secret',
    '**.accessToken', '**.refreshToken', '**.clientSecret',
    '**.Authorization', '**.authorization',
    '**.bearer', '**.credential', '**.jwt',
    '**.x-api-key', '**.x-auth-token',
  ],
  censor: '[REDACTED]',
};

export interface LogFileConfig {
  enabled?: boolean;
  /** Log file path (directory must exist). Default: ./data/logs/alfred.log */
  path?: string;
  /** Max file size before rotation. Accepts '10m', '50m', '100m'. Default: '10m' */
  maxSize?: string;
  /** Number of rotated files to keep. Default: 30 */
  maxFiles?: number;
  /**
   * Rotation frequency. Kept for backwards-compat with v8xx and earlier configs.
   * v843+: only 'daily' rotation is supported; 'hourly' is silently treated as
   * 'daily', and `null` disables date-based rotation (size-only file naming).
   */
  frequency?: 'daily' | 'hourly' | null;
}

/**
 * Detect if stdout is connected to a real terminal/pipe or is detached (nohup, systemd).
 * When detached, writing to stdout causes EIO — so skip stdout transport.
 */
function isStdoutAvailable(): boolean {
  try {
    return process.stdout.writable !== false;
  } catch {
    return false;
  }
}

function parseSize(input: string | undefined): number {
  const DEFAULT = 10 * 1024 * 1024;
  if (!input) return DEFAULT;
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(input.trim());
  if (!m) return DEFAULT;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Math.max(1024, Math.floor(v * mult));
}

export function createLogger(name: string, level?: string, options?: { version?: string; file?: LogFileConfig }): pino.Logger {
  const logLevel = level ?? process.env.LOG_LEVEL ?? 'info';
  const usePretty =
    logLevel === 'debug' ||
    logLevel === 'trace' ||
    process.env.NODE_ENV !== 'production';

  const baseOpts: pino.LoggerOptions = {
    name,
    level: logLevel,
    redact: redactOpts,
    // v611 — without explicit serializers, pino renders Error objects as `{}`
    // because Error.message/stack are non-enumerable and JSON.stringify skips
    // them. We register the standard err-serializer under BOTH `err` (canonical)
    // and `error` (we use this name in some legacy call sites) so future
    // uncaughtExceptions/unhandledRejections actually log their stack trace.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (options?.version) {
    baseOpts.base = { pid: process.pid, version: options.version };
  }

  const fileConf = options?.file;
  const fileEnabled = fileConf?.enabled ?? (process.env.ALFRED_LOG_FILE_ENABLED === 'true');

  const stdoutAvailable = isStdoutAvailable();
  const skipStdout = fileEnabled && !process.stdout.isTTY;

  const streams: Array<{ stream: NodeJS.WritableStream; level?: pino.Level }> = [];

  // stdout / pretty stream
  if (!skipStdout && stdoutAvailable) {
    if (usePretty) {
      // v843 — pino-pretty's default export is a factory returning a Transform
      // stream. Pipe to stdout and pass the transform itself to multistream.
      // Pre-v843 used pino.transport({ target: 'pino-pretty' }) which ran in
      // a worker thread; this main-thread path matches the file stream's
      // sequential write semantics and avoids worker-shutdown races.
      const prettyStream = pretty({ colorize: true });
      prettyStream.pipe(process.stdout);
      streams.push({ stream: prettyStream, level: logLevel as pino.Level });
    } else {
      streams.push({ stream: process.stdout, level: logLevel as pino.Level });
    }
  }

  // file stream — main-thread rotating writer
  if (fileEnabled) {
    const filePath = fileConf?.path ?? process.env.ALFRED_LOG_FILE_PATH ?? './data/logs/alfred.log';
    const maxSizeRaw = fileConf?.maxSize ?? process.env.ALFRED_LOG_FILE_MAX_SIZE ?? '10m';
    const maxFiles = fileConf?.maxFiles ?? (Number(process.env.ALFRED_LOG_FILE_MAX_FILES) || 30);

    try { mkdirSync(dirname(filePath), { recursive: true }); } catch { /* exists */ }

    const fileStream = new RotatingFileStream({
      filePath,
      maxSize: parseSize(maxSizeRaw),
      maxFiles,
      symlink: true,
    });
    fileStream.on('error', (err) => {
      try { process.stderr.write(`[logger] file stream error: ${(err as Error).message}\n`); } catch { /* */ }
    });
    streams.push({ stream: fileStream, level: logLevel as pino.Level });
  }

  // Fallback when no stream resolved (file disabled + stdout unavailable)
  if (streams.length === 0) {
    return pino(baseOpts);
  }

  return pino(baseOpts, pino.multistream(streams));
}
