import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  /** Number of rotated files to keep. Default: 10 */
  maxFiles?: number;
  /** Rotation frequency: 'daily', 'hourly', or null (size-only). Default: 'daily' */
  frequency?: 'daily' | 'hourly' | null;
}

/**
 * Detect if stdout is connected to a real terminal/pipe or is detached (nohup, systemd).
 * When detached, writing to stdout causes EIO — so skip stdout transport.
 */
function isStdoutAvailable(): boolean {
  try {
    // fd 1 not writable when detached (nohup without redirect, closed terminal)
    return process.stdout.writable !== false;
  } catch {
    return false;
  }
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
  };

  // Inject version as a base binding so every log line includes it
  if (options?.version) {
    baseOpts.base = { pid: process.pid, version: options.version };
  }

  const fileConf = options?.file;
  const fileEnabled = fileConf?.enabled ?? (process.env.ALFRED_LOG_FILE_ENABLED === 'true');

  // Build transport targets
  const targets: pino.TransportTargetOptions[] = [];

  // stdout transport: skip when running detached (nohup/systemd) AND file logging is
  // configured anywhere (check ENV directly — the core logger doesn't get the file config
  // but still needs to skip stdout to avoid EIO crashes).
  const globalFileEnabled = fileEnabled || process.env.ALFRED_LOG_FILE_ENABLED === 'true';
  const stdoutAvailable = isStdoutAvailable();
  const skipStdout = globalFileEnabled && !process.stdout.isTTY;

  if (!skipStdout && stdoutAvailable) {
    if (usePretty) {
      targets.push({
        target: 'pino-pretty',
        options: { colorize: true },
        level: logLevel,
      });
    } else {
      targets.push({
        target: 'pino/file',
        options: { destination: 1 },
        level: logLevel,
      });
    }
  }

  if (fileEnabled) {
    const filePath = fileConf?.path ?? process.env.ALFRED_LOG_FILE_PATH ?? './data/logs/alfred.log';
    const maxSize = fileConf?.maxSize ?? process.env.ALFRED_LOG_FILE_MAX_SIZE ?? '10m';
    const maxFiles = fileConf?.maxFiles ?? (Number(process.env.ALFRED_LOG_FILE_MAX_FILES) || 10);
    const frequency = fileConf?.frequency ?? (process.env.ALFRED_LOG_FILE_FREQUENCY as 'daily' | 'hourly' | undefined) ?? 'daily';

    // Ensure directory exists (sync, runs once at startup)
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch { /* directory may already exist */ }

    targets.push({
      target: 'pino-roll',
      options: {
        file: filePath,
        size: maxSize,
        frequency: frequency ?? undefined,
        dateFormat: frequency === 'daily' ? 'yyyy-MM-dd' : frequency === 'hourly' ? 'yyyy-MM-dd-HH' : undefined,
        limit: { count: maxFiles },
      },
      level: logLevel,
    });
  }

  // Fallback: if no targets (file disabled + stdout unavailable), use stdout anyway
  if (targets.length === 0) {
    if (usePretty) {
      const transport = pino.transport({ target: 'pino-pretty', options: { colorize: true } });
      return pino(baseOpts, transport);
    }
    return pino(baseOpts);
  }

  if (targets.length === 1) {
    const transport = pino.transport(targets[0]);
    return pino(baseOpts, transport);
  }

  // Multiple transports (stdout + file)
  const transport = pino.transport({ targets });
  return pino(baseOpts, transport);
}
