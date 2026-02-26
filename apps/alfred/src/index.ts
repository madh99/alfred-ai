import { createLogger } from '@alfred/logger';
import { bootstrap } from './bootstrap.js';
import { setupGracefulShutdown } from './graceful-shutdown.js';

const logger = createLogger('main', 'info');

async function main(): Promise<void> {
  logger.info('Starting Alfred — Personal AI Assistant');

  try {
    const alfred = await bootstrap();
    setupGracefulShutdown(alfred, logger);
    logger.info('Alfred is ready');
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Alfred');
    process.exit(1);
  }
}

main();
