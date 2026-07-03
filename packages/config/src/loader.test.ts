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
    savedEnv['ALFRED_ANTHROPIC_API_KEY'] = process.env['ALFRED_ANTHROPIC_API_KEY'];
    savedEnv['ALFRED_LLM_STRONG_PROVIDER'] = process.env['ALFRED_LLM_STRONG_PROVIDER'];
    savedEnv['ALFRED_LLM_STRONG_MODEL'] = process.env['ALFRED_LLM_STRONG_MODEL'];
    savedEnv['ALFRED_LLM_FAST_PROVIDER'] = process.env['ALFRED_LLM_FAST_PROVIDER'];
    savedEnv['ALFRED_LLM_FAST_MODEL'] = process.env['ALFRED_LLM_FAST_MODEL'];
    savedEnv['ALFRED_LLM_STRONG_API_KEY'] = process.env['ALFRED_LLM_STRONG_API_KEY'];
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

  // v868.1 — fallback-Tier: ENV-Override + Pre-Normalisierung (flat default +
  // fallback-Subobjekt darf NICHT in default geschoben/gestrippt werden)
  it('v868: configures fallback tier from env and survives flat-config normalization', () => {
    process.env['ALFRED_LLM_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_FALLBACK_PROVIDER'] = 'mistral';
    process.env['ALFRED_LLM_FALLBACK_MODEL'] = 'mistral-large-latest';
    try {
      const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');
      expect(config.llm.default.provider).toBe('anthropic');
      expect(config.llm.fallback?.provider).toBe('mistral');
      expect(config.llm.fallback?.model).toBe('mistral-large-latest');
    } finally {
      delete process.env['ALFRED_LLM_FALLBACK_PROVIDER'];
      delete process.env['ALFRED_LLM_FALLBACK_MODEL'];
    }
  });

  // v868.2 — expliziter Tier-Key schlägt die standalone-mistralApiKey-Propagation
  it('v868.2: explicit fallback tier key survives standalone mistralApiKey propagation', () => {
    process.env['ALFRED_LLM_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_FALLBACK_PROVIDER'] = 'mistral';
    process.env['ALFRED_LLM_FALLBACK_MODEL'] = 'mistral-large-latest';
    process.env['ALFRED_LLM_FALLBACK_API_KEY'] = 'expliziter-zweit-key';
    process.env['ALFRED_MISTRAL_API_KEY'] = 'standalone-key';
    try {
      const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');
      // explizit gesetzter Key gewinnt — Propagation darf ihn nicht ersetzen
      expect(config.llm.fallback?.apiKey).toBe('expliziter-zweit-key');
    } finally {
      delete process.env['ALFRED_LLM_FALLBACK_PROVIDER'];
      delete process.env['ALFRED_LLM_FALLBACK_MODEL'];
      delete process.env['ALFRED_LLM_FALLBACK_API_KEY'];
      delete process.env['ALFRED_MISTRAL_API_KEY'];
    }
  });

  // v868.2 — GEERBTER Fehl-Key (Shared-Vererbung) wird weiterhin korrigiert
  it('v868.2: inherited shared key on mistral tier is still corrected by mistralApiKey', () => {
    process.env['ALFRED_LLM_PROVIDER'] = 'anthropic';
    process.env['ALFRED_ANTHROPIC_API_KEY'] = 'anthropic-shared-key';
    process.env['ALFRED_LLM_FALLBACK_PROVIDER'] = 'mistral';
    process.env['ALFRED_LLM_FALLBACK_MODEL'] = 'mistral-large-latest';
    process.env['ALFRED_MISTRAL_API_KEY'] = 'standalone-key';
    try {
      const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');
      // ohne eigenen Key: erst erbt der Tier den Anthropic-Key, dann korrigiert
      // die Mistral-Propagation auf den standalone Key — NICHT der geerbte
      expect(config.llm.fallback?.apiKey).toBe('standalone-key');
    } finally {
      delete process.env['ALFRED_LLM_FALLBACK_PROVIDER'];
      delete process.env['ALFRED_LLM_FALLBACK_MODEL'];
      delete process.env['ALFRED_MISTRAL_API_KEY'];
    }
  });

  // v868.1 — standalone mistralApiKey propagiert in den fallback-Tier (provider mistral)
  it('v868: standalone ALFRED_MISTRAL_API_KEY fills mistral fallback tier key', () => {
    process.env['ALFRED_LLM_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_FALLBACK_PROVIDER'] = 'mistral';
    process.env['ALFRED_LLM_FALLBACK_MODEL'] = 'mistral-large-latest';
    process.env['ALFRED_MISTRAL_API_KEY'] = 'mistral-test-key';
    try {
      const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');
      expect(config.llm.fallback?.apiKey).toBe('mistral-test-key');
    } finally {
      delete process.env['ALFRED_LLM_FALLBACK_PROVIDER'];
      delete process.env['ALFRED_LLM_FALLBACK_MODEL'];
      delete process.env['ALFRED_MISTRAL_API_KEY'];
    }
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

  it('v939: social.enabled=false wird geparst; ohne Block bleibt das Modul default-aktiv', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    // Default (kein social-Block): Modul aktiv — das Gate prüft `enabled === false`
    const defaults = loader.loadConfig('./nonexistent-path/nonexistent.yml');
    expect(defaults.social?.enabled === false).toBe(false);

    // Expliziter Schalter überlebt Schema-Validierung
    const tmp = path.join(os.tmpdir(), `alfred-test-social-config-${Date.now()}.yml`);
    fs.writeFileSync(tmp, 'social:\n  enabled: false\n', 'utf8');
    try {
      const config = loader.loadConfig(tmp);
      expect(config.social?.enabled).toBe(false);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('should propagate top-level apiKey to strong/fast tiers', () => {
    process.env['ALFRED_ANTHROPIC_API_KEY'] = 'sk-test-shared';
    process.env['ALFRED_LLM_STRONG_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_STRONG_MODEL'] = 'claude-opus-4-7';
    process.env['ALFRED_LLM_FAST_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_FAST_MODEL'] = 'claude-haiku-4-5-20251001';

    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config.llm.default.apiKey).toBe('sk-test-shared');
    expect(config.llm.strong?.apiKey).toBe('sk-test-shared');
    expect(config.llm.fast?.apiKey).toBe('sk-test-shared');
  });

  it('should not overwrite tier-specific apiKey during propagation', () => {
    process.env['ALFRED_ANTHROPIC_API_KEY'] = 'sk-test-shared';
    process.env['ALFRED_LLM_STRONG_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_STRONG_MODEL'] = 'claude-opus-4-7';
    process.env['ALFRED_LLM_STRONG_API_KEY'] = 'sk-strong-own';

    const config = loader.loadConfig('./nonexistent-path/nonexistent.yml');

    expect(config.llm.default.apiKey).toBe('sk-test-shared');
    expect(config.llm.strong?.apiKey).toBe('sk-strong-own');
  });
});
