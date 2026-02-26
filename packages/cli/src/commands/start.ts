import { ConfigLoader } from '@alfred/config';
import { createLogger } from '@alfred/logger';
import { Alfred } from '@alfred/core';

export async function startCommand(): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  const logger = createLogger('cli', config.logger.level);

  logger.info({ name: config.name }, 'Configuration loaded');

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
    logger.fatal({ error: err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });

  try {
    await alfred.initialize();
    await alfred.start();
    logger.info('Alfred is ready');
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Alfred');
    process.exit(1);
  }
}
