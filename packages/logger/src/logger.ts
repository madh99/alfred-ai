import pino from 'pino';

const redactOpts = {
  paths: [
    '**.apiKey', '**.token', '**.password', '**.secret',
    '**.accessToken', '**.refreshToken', '**.clientSecret',
    '**.Authorization', '**.authorization',
  ],
  censor: '[REDACTED]',
};

export function createLogger(name: string, level?: string): pino.Logger {
  const logLevel = level ?? process.env.LOG_LEVEL ?? 'info';
  const usePretty =
    logLevel === 'debug' ||
    logLevel === 'trace' ||
    process.env.NODE_ENV !== 'production';

  if (usePretty) {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true },
    });
    return pino({ name, level: logLevel, redact: redactOpts }, transport);
  }

  return pino({ name, level: logLevel, redact: redactOpts });
}
