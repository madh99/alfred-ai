import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from './loader.js';

describe('ConfigLoader', () => {
  let loader: ConfigLoader;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    loader = new ConfigLoader();
    // Save env vars we might modify
    savedEnv['ALFRED_TELEGRAM_TOKEN'] = process.env['ALFRED_TELEGRAM_TOKEN'];
    savedEnv['ALFRED_LLM_PROVIDER'] = process.env['ALFRED_LLM_PROVIDER'];
    savedEnv['ALFRED_CONFIG_PATH'] = process.env['ALFRED_CONFIG_PATH'];
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should load default config when no file exists', () => {
    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config).toBeDefined();
    expect(config.name).toBe('Alfred');
    expect(config.telegram).toBeDefined();
    expect(config.llm).toBeDefined();
    expect(config.storage).toBeDefined();
    expect(config.logger).toBeDefined();
    expect(config.security).toBeDefined();
  });

  it('should apply environment variable overrides', () => {
    process.env['ALFRED_TELEGRAM_TOKEN'] = 'test-token';

    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config.telegram.token).toBe('test-token');
  });

  it('should override LLM provider from env', () => {
    process.env['ALFRED_LLM_PROVIDER'] = 'openai';

    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config.llm.default.provider).toBe('openai');
  });

  it('should validate config schema', () => {
    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config).toHaveProperty('name');
    expect(config).toHaveProperty('telegram');
    expect(config).toHaveProperty('llm');
    expect(config).toHaveProperty('storage');
    expect(config).toHaveProperty('logger');
    expect(config).toHaveProperty('security');
  });
});
