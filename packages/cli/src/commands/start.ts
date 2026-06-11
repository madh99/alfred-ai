import { ConfigLoader } from '@alfred/config';
import { createLogger } from '@alfred/logger';
import { Alfred } from '@alfred/core';
import { refreshCacheInBackground } from '../model-discovery.js';
import { getVersion } from '../version.js';

export async function startCommand(): Promise<void> {
  const configLoader = new ConfigLoader();
  const version = getVersion();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  const logger = createLogger('alfred', config.logger.level, {
    version,
    file: config.logger.file,
  });

  logger.info({ nodeVersion: process.version }, 'Alfred starting');

  const alfred = new Alfred(config);

  // Set up graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');

    try {
      await alfred.stop();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    // v611 — use `err` key so pino's stdSerializers.err captures stack trace.
    // Previously this used `{ error: err }` which serialized as `{}` because
    // Error properties are non-enumerable. Cost us a real diagnosis when the
    // pino-roll@2 midnight crash hit alfred on 2026-05-20T00:00 UTC.
    logger.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });

  try {
    await alfred.initialize();
    await alfred.start();
    logger.info('Alfred is ready');

    // Refresh model cache in background for all configured providers
    const llm = config.llm as Record<string, any>;
    if (llm?.default?.provider) {
      refreshCacheInBackground(llm.default.provider, llm.default.apiKey, llm.default.baseUrl);
    } else if (llm?.provider) {
      refreshCacheInBackground(llm.provider, undefined, llm.baseUrl);
    }
    for (const tier of ['strong', 'fast', 'fallback'] as const) {
      const tc = llm?.[tier];
      if (tc?.provider) {
        refreshCacheInBackground(tc.provider, tc.apiKey, tc.baseUrl);
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.fatal({ err }, 'Failed to start Alfred');
    process.exit(1);
  }
}
