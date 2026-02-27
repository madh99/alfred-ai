import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ConfigLoader } from '@alfred/config';
import { RuleLoader } from '@alfred/security';

interface AdapterStatus {
  name: string;
  enabled: boolean;
  configured: boolean;
}

export async function statusCommand(): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  console.log('Alfred — Status');
  console.log('================');
  console.log('');

  // Adapters
  const adapters: AdapterStatus[] = [
    {
      name: 'Telegram',
      enabled: config.telegram.enabled,
      configured: Boolean(config.telegram.token),
    },
    {
      name: 'Discord',
      enabled: Boolean(config.discord?.enabled),
      configured: Boolean(config.discord?.token),
    },
    {
      name: 'WhatsApp',
      enabled: Boolean(config.whatsapp?.enabled),
      configured: Boolean(config.whatsapp?.dataPath),
    },
    {
      name: 'Matrix',
      enabled: Boolean(config.matrix?.enabled),
      configured: Boolean(config.matrix?.accessToken),
    },
    {
      name: 'Signal',
      enabled: Boolean(config.signal?.enabled),
      configured: Boolean(config.signal?.phoneNumber),
    },
  ];

  console.log('Messaging Adapters:');
  for (const adapter of adapters) {
    const status = adapter.enabled
      ? 'enabled'
      : adapter.configured
        ? 'configured (disabled)'
        : 'not configured';
    const icon = adapter.enabled ? '+' : '-';
    console.log(`  [${icon}] ${adapter.name}: ${status}`);
  }
  console.log('');

  // LLM Provider
  console.log('LLM Provider:');
  const defaultLlm = config.llm.default;
  console.log(`  Provider: ${defaultLlm.provider}`);
  console.log(`  Model:    ${defaultLlm.model}`);
  console.log(`  API Key:  ${defaultLlm.apiKey ? 'set' : 'not set'}`);
  if (defaultLlm.baseUrl) {
    console.log(`  Base URL: ${defaultLlm.baseUrl}`);
  }
  for (const tier of ['strong', 'fast', 'embeddings', 'local'] as const) {
    const tierConfig = config.llm[tier];
    if (tierConfig) {
      console.log(`  ${tier}: ${tierConfig.provider}/${tierConfig.model}`);
    }
  }
  console.log('');

  // Storage
  console.log('Storage:');
  const dbPath = path.resolve(config.storage.path);
  const dbExists = fs.existsSync(dbPath);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Status:   ${dbExists ? 'exists' : 'not yet created'}`);
  console.log('');

  // Security rules
  const rulesPath = path.resolve(config.security.rulesPath);
  let ruleCount = 0;
  let ruleFileCount = 0;

  if (fs.existsSync(rulesPath) && fs.statSync(rulesPath).isDirectory()) {
    const files = fs.readdirSync(rulesPath).filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
    );
    ruleFileCount = files.length;

    const ruleLoader = new RuleLoader();
    for (const file of files) {
      const filePath = path.join(rulesPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(raw) as { rules: unknown[] };
        const rules = ruleLoader.loadFromObject(parsed);
        ruleCount += rules.length;
      } catch {
        // Skip invalid files in status display
      }
    }
  }

  console.log('Security:');
  console.log(`  Rules path:      ${rulesPath}`);
  console.log(`  Rule files:      ${ruleFileCount}`);
  console.log(`  Rules loaded:    ${ruleCount}`);
  console.log(`  Default effect:  ${config.security.defaultEffect}`);
  if (config.security.ownerUserId) {
    console.log(`  Owner user ID:   ${config.security.ownerUserId}`);
  }
  console.log('');

  // Logger
  console.log('Logger:');
  console.log(`  Level:  ${config.logger.level}`);
  console.log(`  Pretty: ${config.logger.pretty}`);
}
