import { ConfigLoader } from '@alfred/config';
import { Alfred } from '@alfred/core';
import type { ModelTier } from '@alfred/types';

export async function chatCommand(flags: { model?: string; tier?: string }): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  // Suppress noisy logs in interactive chat
  config.logger.level = 'warn';

  // --model override: set the default tier's model
  if (flags.model) {
    config.llm.default.model = flags.model;
  }

  // --tier override: promote that tier's config to default
  if (flags.tier) {
    const tierConfig = config.llm[flags.tier as ModelTier];
    if (tierConfig) {
      config.llm.default = tierConfig;
    } else {
      console.error(`Unknown tier: ${flags.tier}. Available tiers: default, strong, fast, embeddings, local`);
      process.exit(1);
    }
  }

  const alfred = new Alfred(config);

  try {
    await alfred.initialize();
    await alfred.startWithCLI();
  } catch (error) {
    console.error('Failed to start chat:', (error as Error).message);
    process.exit(1);
  }
}
