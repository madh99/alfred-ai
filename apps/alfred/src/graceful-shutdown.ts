import type { Alfred } from '@alfred/core';
import type { Logger } from 'pino';

export function setupGracefulShutdown(alfred: Alfred, logger: Logger): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');

    try {
      const SHUTDOWN_TIMEOUT = 15_000;
      await Promise.race([
        alfred.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout after 15s')), SHUTDOWN_TIMEOUT)),
      ]);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown, forcing exit');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    void shutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection').catch(() => process.exit(1));
  });
}
