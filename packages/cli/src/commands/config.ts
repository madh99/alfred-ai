import { ConfigLoader } from '@alfred/config';

/**
 * Fields whose values should be redacted when displaying config.
 * Matches by key name (case-insensitive substring).
 */
const SENSITIVE_KEYS = ['token', 'apikey', 'api_key', 'accesstoken', 'secret', 'password'];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s));
}

function redactValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '(empty)';
  }
  if (value.length <= 8) {
    return '***';
  }
  return value.slice(0, 4) + '...' + value.slice(-4);
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = redactValue(value);
    } else if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function configCommand(): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  const redacted = redactObject(config as unknown as Record<string, unknown>);

  console.log('Alfred — Resolved Configuration');
  console.log('================================');
  console.log(JSON.stringify(redacted, null, 2));
}
