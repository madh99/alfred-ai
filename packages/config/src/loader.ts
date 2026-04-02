import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import yaml from 'js-yaml';
import type { AlfredConfig } from '@alfred/types';
import { AlfredConfigSchema } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      targetVal !== undefined &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

const ENV_MAP: Record<string, string[]> = {
  ALFRED_MISTRAL_API_KEY: ['mistralApiKey'],
  ALFRED_TELEGRAM_TOKEN: ['telegram', 'token'],
  ALFRED_TELEGRAM_ENABLED: ['telegram', 'enabled'],
  ALFRED_DISCORD_TOKEN: ['discord', 'token'],
  ALFRED_DISCORD_ENABLED: ['discord', 'enabled'],
  ALFRED_MATRIX_HOMESERVER_URL: ['matrix', 'homeserverUrl'],
  ALFRED_MATRIX_ACCESS_TOKEN: ['matrix', 'accessToken'],
  ALFRED_MATRIX_USER_ID: ['matrix', 'userId'],
  ALFRED_MATRIX_ENABLED: ['matrix', 'enabled'],
  ALFRED_SIGNAL_API_URL: ['signal', 'apiUrl'],
  ALFRED_SIGNAL_PHONE_NUMBER: ['signal', 'phoneNumber'],
  ALFRED_SIGNAL_ENABLED: ['signal', 'enabled'],
  ALFRED_ANTHROPIC_API_KEY: ['llm', 'apiKey'],
  ALFRED_OPENAI_API_KEY: ['llm', 'apiKey'],
  ALFRED_GOOGLE_API_KEY: ['llm', 'apiKey'],
  ALFRED_OPENROUTER_API_KEY: ['llm', 'apiKey'],
  ALFRED_OPENWEBUI_API_KEY: ['llm', 'apiKey'],
  ALFRED_LLM_PROVIDER: ['llm', 'provider'],
  ALFRED_LLM_MODEL: ['llm', 'model'],
  ALFRED_LLM_BASE_URL: ['llm', 'baseUrl'],
  ALFRED_LLM_STRONG_PROVIDER: ['llm', 'strong', 'provider'],
  ALFRED_LLM_STRONG_MODEL: ['llm', 'strong', 'model'],
  ALFRED_LLM_STRONG_API_KEY: ['llm', 'strong', 'apiKey'],
  ALFRED_LLM_FAST_PROVIDER: ['llm', 'fast', 'provider'],
  ALFRED_LLM_FAST_MODEL: ['llm', 'fast', 'model'],
  ALFRED_LLM_FAST_API_KEY: ['llm', 'fast', 'apiKey'],
  ALFRED_LLM_EMBEDDINGS_PROVIDER: ['llm', 'embeddings', 'provider'],
  ALFRED_LLM_EMBEDDINGS_MODEL: ['llm', 'embeddings', 'model'],
  ALFRED_LLM_EMBEDDINGS_API_KEY: ['llm', 'embeddings', 'apiKey'],
  ALFRED_LLM_LOCAL_PROVIDER: ['llm', 'local', 'provider'],
  ALFRED_LLM_LOCAL_MODEL: ['llm', 'local', 'model'],
  ALFRED_LLM_LOCAL_BASE_URL: ['llm', 'local', 'baseUrl'],
  ALFRED_STORAGE_PATH: ['storage', 'path'],
  ALFRED_STORAGE_BACKEND: ['storage', 'backend'],
  ALFRED_STORAGE_CONNECTION_STRING: ['storage', 'connectionString'],
  ALFRED_FILE_STORE_BACKEND: ['fileStore', 'backend'],
  ALFRED_FILE_STORE_BASE_PATH: ['fileStore', 'basePath'],
  ALFRED_FILE_STORE_S3_ENDPOINT: ['fileStore', 's3Endpoint'],
  ALFRED_FILE_STORE_S3_BUCKET: ['fileStore', 's3Bucket'],
  ALFRED_S3_ACCESS_KEY: ['fileStore', 's3AccessKey'],
  ALFRED_S3_SECRET_KEY: ['fileStore', 's3SecretKey'],
  ALFRED_CLUSTER_ENABLED: ['cluster', 'enabled'],
  ALFRED_CLUSTER_NODE_ID: ['cluster', 'nodeId'],
  ALFRED_CLUSTER_ROLE: ['cluster', 'role'],
  ALFRED_CLUSTER_REDIS_URL: ['cluster', 'redisUrl'],
  ALFRED_CLUSTER_TOKEN: ['cluster', 'token'],
  ALFRED_API_PORT: ['api', 'port'],
  ALFRED_API_HOST: ['api', 'host'],
  ALFRED_API_TOKEN: ['api', 'token'],
  ALFRED_API_CORS_ORIGIN: ['api', 'corsOrigin'],
  ALFRED_API_PUBLIC_URL: ['api', 'publicUrl'],
  ALFRED_SECURITY_DEFAULT_EFFECT: ['security', 'defaultEffect'],
  ALFRED_SECURITY_RULES_PATH: ['security', 'rulesPath'],
  ALFRED_MODERATION_ENABLED: ['security', 'moderation', 'enabled'],
  ALFRED_MODERATION_PROVIDER: ['security', 'moderation', 'provider'],
  ALFRED_MODERATION_MODEL: ['security', 'moderation', 'model'],
  ALFRED_LOG_LEVEL: ['logger', 'level'],
  ALFRED_OWNER_USER_ID: ['security', 'ownerUserId'],
  ALFRED_SEARCH_PROVIDER: ['search', 'provider'],
  ALFRED_SEARCH_API_KEY: ['search', 'apiKey'],
  ALFRED_SEARCH_BASE_URL: ['search', 'baseUrl'],
  ALFRED_EMAIL_PROVIDER: ['email', 'provider'],
  ALFRED_EMAIL_USER: ['email', 'auth', 'user'],
  ALFRED_EMAIL_PASS: ['email', 'auth', 'pass'],
  ALFRED_MICROSOFT_EMAIL_CLIENT_ID: ['email', 'microsoft', 'clientId'],
  ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET: ['email', 'microsoft', 'clientSecret'],
  ALFRED_MICROSOFT_EMAIL_TENANT_ID: ['email', 'microsoft', 'tenantId'],
  ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN: ['email', 'microsoft', 'refreshToken'],
  ALFRED_SPEECH_PROVIDER: ['speech', 'provider'],
  ALFRED_SPEECH_API_KEY: ['speech', 'apiKey'],
  ALFRED_SPEECH_BASE_URL: ['speech', 'baseUrl'],
  ALFRED_STT_PROVIDER: ['speech', 'sttProvider'],
  ALFRED_TTS_PROVIDER: ['speech', 'ttsProvider'],
  ALFRED_STT_API_KEY: ['speech', 'sttApiKey'],
  ALFRED_TTS_API_KEY: ['speech', 'ttsApiKey'],
  ALFRED_VOICE_MANAGEMENT: ['speech', 'voiceManagement'],
  ALFRED_TTS_VOICE_ID: ['speech', 'defaultVoiceId'],
  ALFRED_CALENDAR_PROVIDER: ['calendar', 'provider'],
  ALFRED_CALDAV_SERVER_URL: ['calendar', 'caldav', 'serverUrl'],
  ALFRED_CALDAV_USERNAME: ['calendar', 'caldav', 'username'],
  ALFRED_CALDAV_PASSWORD: ['calendar', 'caldav', 'password'],
  ALFRED_GOOGLE_CALENDAR_CLIENT_ID: ['calendar', 'google', 'clientId'],
  ALFRED_GOOGLE_CALENDAR_CLIENT_SECRET: ['calendar', 'google', 'clientSecret'],
  ALFRED_GOOGLE_CALENDAR_REFRESH_TOKEN: ['calendar', 'google', 'refreshToken'],
  ALFRED_MICROSOFT_CALENDAR_CLIENT_ID: ['calendar', 'microsoft', 'clientId'],
  ALFRED_MICROSOFT_CALENDAR_CLIENT_SECRET: ['calendar', 'microsoft', 'clientSecret'],
  ALFRED_MICROSOFT_CALENDAR_TENANT_ID: ['calendar', 'microsoft', 'tenantId'],
  ALFRED_MICROSOFT_CALENDAR_REFRESH_TOKEN: ['calendar', 'microsoft', 'refreshToken'],
  ALFRED_FORGE_PROVIDER: ['codeAgents', 'forge', 'provider'],
  ALFRED_FORGE_BASE_BRANCH: ['codeAgents', 'forge', 'baseBranch'],
  ALFRED_GITHUB_TOKEN: ['codeAgents', 'forge', 'github', 'token'],
  ALFRED_GITHUB_BASE_URL: ['codeAgents', 'forge', 'github', 'baseUrl'],
  ALFRED_GITLAB_TOKEN: ['codeAgents', 'forge', 'gitlab', 'token'],
  ALFRED_GITLAB_BASE_URL: ['codeAgents', 'forge', 'gitlab', 'baseUrl'],
  ALFRED_PROXMOX_BASE_URL: ['proxmox', 'baseUrl'],
  ALFRED_PROXMOX_TOKEN_ID: ['proxmox', 'tokenId'],
  ALFRED_PROXMOX_TOKEN_SECRET: ['proxmox', 'tokenSecret'],
  ALFRED_PROXMOX_VERIFY_TLS: ['proxmox', 'verifyTls'],
  ALFRED_UNIFI_BASE_URL: ['unifi', 'baseUrl'],
  ALFRED_UNIFI_API_KEY: ['unifi', 'apiKey'],
  ALFRED_UNIFI_USERNAME: ['unifi', 'username'],
  ALFRED_UNIFI_PASSWORD: ['unifi', 'password'],
  ALFRED_UNIFI_SITE: ['unifi', 'site'],
  ALFRED_UNIFI_VERIFY_TLS: ['unifi', 'verifyTls'],
  ALFRED_HOMEASSISTANT_URL: ['homeassistant', 'baseUrl'],
  ALFRED_HOMEASSISTANT_TOKEN: ['homeassistant', 'accessToken'],
  ALFRED_HOMEASSISTANT_VERIFY_TLS: ['homeassistant', 'verifyTls'],
  // Contacts
  ALFRED_CONTACTS_PROVIDER: ['contacts', 'provider'],
  ALFRED_CARDDAV_CONTACTS_SERVER_URL: ['contacts', 'carddav', 'serverUrl'],
  ALFRED_CARDDAV_CONTACTS_USERNAME: ['contacts', 'carddav', 'username'],
  ALFRED_CARDDAV_CONTACTS_PASSWORD: ['contacts', 'carddav', 'password'],
  ALFRED_GOOGLE_CONTACTS_CLIENT_ID: ['contacts', 'google', 'clientId'],
  ALFRED_GOOGLE_CONTACTS_CLIENT_SECRET: ['contacts', 'google', 'clientSecret'],
  ALFRED_GOOGLE_CONTACTS_REFRESH_TOKEN: ['contacts', 'google', 'refreshToken'],
  ALFRED_MICROSOFT_CONTACTS_CLIENT_ID: ['contacts', 'microsoft', 'clientId'],
  ALFRED_MICROSOFT_CONTACTS_CLIENT_SECRET: ['contacts', 'microsoft', 'clientSecret'],
  ALFRED_MICROSOFT_CONTACTS_TENANT_ID: ['contacts', 'microsoft', 'tenantId'],
  ALFRED_MICROSOFT_CONTACTS_REFRESH_TOKEN: ['contacts', 'microsoft', 'refreshToken'],
  // Docker
  ALFRED_DOCKER_SOCKET_PATH: ['docker', 'socketPath'],
  ALFRED_DOCKER_HOST: ['docker', 'host'],
  ALFRED_DOCKER_VERIFY_TLS: ['docker', 'verifyTls'],
  // Bitpanda
  ALFRED_BITPANDA_API_KEY: ['bitpanda', 'apiKey'],
  // Trading (CCXT)
  ALFRED_TRADING_DEFAULT_EXCHANGE: ['trading', 'defaultExchange'],
  ALFRED_TRADING_DEFAULT_QUOTE: ['trading', 'defaultQuote'],
  ALFRED_TRADING_MAX_ORDER_EUR: ['trading', 'maxOrderEur'],
  ALFRED_TRADING_SANDBOX: ['trading', 'sandbox'],
  // go-e Charger
  ALFRED_GOE_HOST: ['goeCharger', 'host'],
  // BMW CarData
  ALFRED_BMW_CLIENT_ID: ['bmw', 'clientId'],
  ALFRED_BMW_STREAMING_ENABLED: ['bmw', 'streaming', 'enabled'],
  ALFRED_BMW_STREAMING_USERNAME: ['bmw', 'streaming', 'username'],
  ALFRED_BMW_STREAMING_TOPIC: ['bmw', 'streaming', 'topic'],
  ALFRED_BMW_STREAMING_HOST: ['bmw', 'streaming', 'host'],
  ALFRED_BMW_STREAMING_PORT: ['bmw', 'streaming', 'port'],
  // YouTube
  ALFRED_YOUTUBE_API_KEY: ['youtube', 'apiKey'],
  ALFRED_SUPADATA_API_KEY: ['youtube', 'supadata', 'apiKey'],
  // Google Routing
  ALFRED_ROUTING_API_KEY: ['routing', 'apiKey'],
  // Microsoft To Do
  ALFRED_MICROSOFT_TODO_CLIENT_ID: ['todo', 'clientId'],
  ALFRED_MICROSOFT_TODO_CLIENT_SECRET: ['todo', 'clientSecret'],
  ALFRED_MICROSOFT_TODO_TENANT_ID: ['todo', 'tenantId'],
  ALFRED_MICROSOFT_TODO_REFRESH_TOKEN: ['todo', 'refreshToken'],
  // Energy / aWATTar
  ALFRED_ENERGY_GRID_NAME: ['energy', 'gridName'],
  ALFRED_ENERGY_GRID_USAGE_CT: ['energy', 'gridUsageCt'],
  ALFRED_ENERGY_GRID_LOSS_CT: ['energy', 'gridLossCt'],
  ALFRED_ENERGY_GRID_CAPACITY_FEE: ['energy', 'gridCapacityFee'],
  ALFRED_ENERGY_GRID_METER_FEE: ['energy', 'gridMeterFee'],
  // Proxmox Backup Server
  ALFRED_PBS_BASE_URL: ['proxmoxBackup', 'baseUrl'],
  ALFRED_PBS_TOKEN_ID: ['proxmoxBackup', 'tokenId'],
  ALFRED_PBS_TOKEN_SECRET: ['proxmoxBackup', 'tokenSecret'],
  ALFRED_PBS_MAX_AGE_HOURS: ['proxmoxBackup', 'maxAgeHours'],
  ALFRED_PBS_VERIFY_TLS: ['proxmoxBackup', 'verifyTls'],
  // Marketplace (eBay)
  ALFRED_EBAY_APP_ID: ['marketplace', 'ebay', 'appId'],
  ALFRED_EBAY_CERT_ID: ['marketplace', 'ebay', 'certId'],
  // Briefing
  ALFRED_BRIEFING_LOCATION: ['briefing', 'location'],
  ALFRED_BRIEFING_HOME_ADDRESS: ['briefing', 'homeAddress'],
  ALFRED_BRIEFING_OFFICE_ADDRESS: ['briefing', 'officeAddress'],
  // Reasoning Engine
  ALFRED_REASONING_ENABLED: ['reasoning', 'enabled'],
  ALFRED_REASONING_SCHEDULE: ['reasoning', 'schedule'],
  ALFRED_REASONING_TIER: ['reasoning', 'tier'],
  // Recipe
  ALFRED_RECIPE_SPOONACULAR_API_KEY: ['recipe', 'spoonacular', 'apiKey'],
  ALFRED_RECIPE_EDAMAM_APP_ID: ['recipe', 'edamam', 'appId'],
  ALFRED_RECIPE_EDAMAM_APP_KEY: ['recipe', 'edamam', 'appKey'],
  // Spotify
  ALFRED_SPOTIFY_CLIENT_ID: ['spotify', 'clientId'],
  ALFRED_SPOTIFY_CLIENT_SECRET: ['spotify', 'clientSecret'],
  ALFRED_SPOTIFY_REFRESH_TOKEN: ['spotify', 'refreshToken'],
  // Sonos
  ALFRED_SONOS_CLOUD_CLIENT_ID: ['sonos', 'cloud', 'clientId'],
  ALFRED_SONOS_CLOUD_CLIENT_SECRET: ['sonos', 'cloud', 'clientSecret'],
  ALFRED_SONOS_CLOUD_REFRESH_TOKEN: ['sonos', 'cloud', 'refreshToken'],
  // Travel
  ALFRED_TRAVEL_KIWI_API_KEY: ['travel', 'kiwi', 'apiKey'],
  ALFRED_TRAVEL_BOOKING_RAPID_API_KEY: ['travel', 'booking', 'rapidApiKey'],
  ALFRED_TRAVEL_AMADEUS_CLIENT_ID: ['travel', 'amadeus', 'clientId'],
  ALFRED_TRAVEL_AMADEUS_CLIENT_SECRET: ['travel', 'amadeus', 'clientSecret'],
  ALFRED_TRAVEL_DEFAULT_CURRENCY: ['travel', 'defaultCurrency'],
  ALFRED_TRAVEL_DEFAULT_ORIGIN: ['travel', 'defaultOrigin'],
  // MQTT
  ALFRED_MQTT_BROKER_URL: ['mqtt', 'brokerUrl'],
  ALFRED_MQTT_USERNAME: ['mqtt', 'username'],
  ALFRED_MQTT_PASSWORD: ['mqtt', 'password'],
  ALFRED_MQTT_CLIENT_ID: ['mqtt', 'clientId'],
  ALFRED_MQTT_TOPIC_PREFIX: ['mqtt', 'topicPrefix'],
};

/** Coerce ENV string "true"/"false" to boolean. Numbers stay as strings
 *  (Zod schemas and downstream code handle string→number conversion). */
/** ENV keys that should be coerced to numbers. */
const NUMERIC_ENV_KEYS = new Set([
  'ALFRED_API_PORT',
  'ALFRED_BMW_STREAMING_PORT',
]);

let _currentEnvKey = '';

function coerceEnvValue(value: string): string | boolean | number {
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  // Only coerce to number for explicitly numeric fields
  if (NUMERIC_ENV_KEYS.has(_currentEnvKey) && /^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  for (const [envVar, keyPath] of Object.entries(ENV_MAP)) {
    const value = process.env[envVar];
    if (value === undefined) continue;
    _currentEnvKey = envVar;

    let current = result;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current[key] = { ...(current[key] as Record<string, unknown>) };
      current = current[key] as Record<string, unknown>;
    }
    current[keyPath[keyPath.length - 1]] = coerceEnvValue(value);
  }
  return result;
}

export function reloadDotenv(): void {
  loadDotenv({ override: true });
}

export class ConfigLoader {
  loadConfig(configPath?: string): AlfredConfig {
    loadDotenv();

    const resolvedPath = configPath ?? process.env['ALFRED_CONFIG_PATH'] ?? './config/default.yml';

    let fileConfig: Record<string, unknown> = {};
    const absolutePath = path.resolve(resolvedPath);
    if (fs.existsSync(absolutePath)) {
      const raw = fs.readFileSync(absolutePath, 'utf-8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        fileConfig = parsed as Record<string, unknown>;
      }
    }

    const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
    const withEnv = applyEnvOverrides(merged);

    // Resolve dynamic trading exchange keys from ENV
    // Pattern: ALFRED_TRADING_{EXCHANGE}_API_KEY / _SECRET
    const tradingExchanges = (process.env['ALFRED_TRADING_EXCHANGES'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (tradingExchanges.length > 0) {
      const trading = (withEnv.trading ?? {}) as Record<string, unknown>;
      const exchanges = (trading.exchanges ?? {}) as Record<string, Record<string, string>>;
      for (const ex of tradingExchanges) {
        const upper = ex.toUpperCase();
        const apiKey = process.env[`ALFRED_TRADING_${upper}_API_KEY`];
        const secret = process.env[`ALFRED_TRADING_${upper}_SECRET`];
        if (apiKey && secret) {
          exchanges[ex] = { apiKey, secret };
        }
      }
      trading.exchanges = exchanges;
      withEnv.trading = trading;
    }

    // Pre-normalize LLM config before Zod validation:
    // When env vars set both flat keys (provider, model) and tier sub-objects
    // (strong, fast), the Zod union would pick the flat schema and strip tiers.
    // Move flat keys into `default` so MultiModelConfigSchema is matched.
    const tiers = ['strong', 'fast', 'embeddings', 'local'] as const;
    const preLlm = withEnv.llm as Record<string, unknown> | undefined;
    if (preLlm && 'provider' in preLlm) {
      const hasTierSubObjects = tiers.some(t => preLlm[t] && typeof preLlm[t] === 'object');
      if (hasTierSubObjects) {
        const flatKeys: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(preLlm)) {
          if (!tiers.includes(k as typeof tiers[number]) && k !== 'default') {
            flatKeys[k] = v;
          }
        }
        const normalized: Record<string, unknown> = { default: flatKeys };
        for (const tier of tiers) {
          if (preLlm[tier]) normalized[tier] = preLlm[tier];
        }
        withEnv.llm = normalized;
      }
    }

    const validated = AlfredConfigSchema.parse(withEnv) as Record<string, unknown>;

    // Normalize flat LLM config → multi-model format (when no tier sub-objects)
    const llm = validated.llm as Record<string, unknown>;
    if (llm && 'provider' in llm) {
      validated.llm = { default: llm };
    }

    // Propagate top-level LLM apiKey to tiers that lack their own
    const llmConfig = validated.llm as Record<string, unknown>;
    if (llmConfig && typeof llmConfig === 'object') {
      const sharedApiKey = (llmConfig as Record<string, unknown>).apiKey as string | undefined
        ?? ((llmConfig.default as Record<string, unknown> | undefined)?.apiKey as string | undefined);

      if (sharedApiKey) {
        for (const tier of ['default', 'strong', 'fast', 'embeddings', 'local']) {
          const tierConfig = llmConfig[tier] as Record<string, unknown> | undefined;
          if (tierConfig && !tierConfig.apiKey) {
            tierConfig.apiKey = sharedApiKey;
          }
        }
      }
    }

    // Propagate standalone mistralApiKey into LLM default tier when provider is mistral
    // (fixes: ALFRED_MISTRAL_API_KEY must work both as standalone key AND as LLM provider key)
    const mistralApiKey = validated.mistralApiKey as string | undefined;
    if (mistralApiKey && llmConfig) {
      const defaultTier = llmConfig.default as Record<string, unknown> | undefined;
      if (defaultTier?.provider === 'mistral' && !defaultTier.apiKey) {
        defaultTier.apiKey = mistralApiKey;
      }
      // Also fill tier keys when tier provider is mistral
      // (override any inherited default-tier key — e.g. Anthropic key from shared propagation)
      for (const tier of ['strong', 'fast', 'embeddings', 'local']) {
        const tierConfig = llmConfig[tier] as Record<string, unknown> | undefined;
        if (tierConfig?.provider === 'mistral') {
          tierConfig.apiKey = mistralApiKey;
        }
      }
    }

    // Normalize flat email config → multi-account format
    const email = validated.email as Record<string, unknown> | undefined;
    if (email && !('accounts' in email)) {
      validated.email = { accounts: [{ name: 'default', ...email }] };
    } else if (email && 'accounts' in email && 'microsoft' in email) {
      // YAML has accounts[] but ENV set email.microsoft.* — merge ENV into first microsoft account
      const envMs = email.microsoft as Record<string, unknown> | undefined;
      if (envMs) {
        const accounts = email.accounts as Array<Record<string, unknown>>;
        const msAccount = accounts.find(a => a.provider === 'microsoft');
        if (msAccount) {
          const acctMs = (msAccount.microsoft ?? {}) as Record<string, unknown>;
          // ENV overrides YAML values (e.g. refreshToken from .env replaces stale YAML token)
          msAccount.microsoft = { ...acctMs, ...envMs };
        }
        delete email.microsoft;
      }
    }

    // Validate storage path against forbidden directories
    const storage = validated.storage as Record<string, unknown> | undefined;
    if (storage?.path && typeof storage.path === 'string') {
      validateStoragePath(storage.path);
    }

    return validated as unknown as AlfredConfig;
  }
}

function validateStoragePath(p: string): void {
  const resolved = path.resolve(p);
  const forbidden = process.platform === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    : ['/etc', '/bin', '/proc', '/sys', '/dev', '/boot'];
  for (const f of forbidden) {
    if (resolved.startsWith(f + path.sep) || resolved.startsWith(f + '/') || resolved === f) {
      throw new Error(`Storage path "${resolved}" is in forbidden directory ${f}`);
    }
  }
}
