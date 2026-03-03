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
  ALFRED_TELEGRAM_TOKEN: ['telegram', 'token'],
  ALFRED_DISCORD_TOKEN: ['discord', 'token'],
  ALFRED_MATRIX_HOMESERVER_URL: ['matrix', 'homeserverUrl'],
  ALFRED_MATRIX_ACCESS_TOKEN: ['matrix', 'accessToken'],
  ALFRED_MATRIX_USER_ID: ['matrix', 'userId'],
  ALFRED_SIGNAL_API_URL: ['signal', 'apiUrl'],
  ALFRED_SIGNAL_PHONE_NUMBER: ['signal', 'phoneNumber'],
  ALFRED_ANTHROPIC_API_KEY: ['llm', 'apiKey'],
  ALFRED_OPENAI_API_KEY: ['llm', 'apiKey'],
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
  ALFRED_UNIFI_BASE_URL: ['unifi', 'baseUrl'],
  ALFRED_UNIFI_API_KEY: ['unifi', 'apiKey'],
  ALFRED_UNIFI_USERNAME: ['unifi', 'username'],
  ALFRED_UNIFI_PASSWORD: ['unifi', 'password'],
  ALFRED_UNIFI_SITE: ['unifi', 'site'],
  ALFRED_HOMEASSISTANT_URL: ['homeassistant', 'baseUrl'],
  ALFRED_HOMEASSISTANT_TOKEN: ['homeassistant', 'accessToken'],
};

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  for (const [envVar, keyPath] of Object.entries(ENV_MAP)) {
    const value = process.env[envVar];
    if (value === undefined) continue;

    let current = result;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current[key] = { ...(current[key] as Record<string, unknown>) };
      current = current[key] as Record<string, unknown>;
    }
    current[keyPath[keyPath.length - 1]] = value;
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
    const validated = AlfredConfigSchema.parse(withEnv) as Record<string, unknown>;

    // Normalize flat LLM config → multi-model format
    const llm = validated.llm as Record<string, unknown>;
    if (llm && 'provider' in llm) {
      validated.llm = { default: llm };
    }

    // Normalize flat email config → multi-account format
    const email = validated.email as Record<string, unknown> | undefined;
    if (email && !('accounts' in email)) {
      validated.email = { accounts: [{ name: 'default', ...email }] };
    }

    return validated as unknown as AlfredConfig;
  }
}
