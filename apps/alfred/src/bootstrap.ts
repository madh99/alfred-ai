import { ConfigLoader } from '@alfred/config';
import { createLogger } from '@alfred/logger';
import { Alfred } from '@alfred/core';

export async function bootstrap(): Promise<Alfred> {
  const configLoader = new ConfigLoader();
  const config = configLoader.loadConfig();

  const logger = createLogger('bootstrap', config.logger.level);
  logger.info({ name: config.name }, 'Configuration loaded');

  const alfred = new Alfred(config);
  await alfred.initialize();
  await alfred.start();

  return alfred;
}
