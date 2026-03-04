import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Types ────────────────────────────────────────────────────────────

export interface CachedModel {
  id: string;
  name?: string;
}

interface ProviderCache {
  fetchedAt: number;
  models: CachedModel[];
}

interface ModelCache {
  version: 1;
  providers: Record<string, ProviderCache>;
}

// ── Constants ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_PATH = path.join(os.homedir(), '.alfred', 'model-cache.json');

// ── Cache I/O ────────────────────────────────────────────────────────

function readCache(): ModelCache {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed.providers) return parsed as ModelCache;
  } catch { /* missing or corrupt */ }
  return { version: 1, providers: {} };
}

function writeCache(cache: ModelCache): void {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// ── Fetch logic per provider ─────────────────────────────────────────

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchModelsFromAPI(
  provider: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<CachedModel[]> {
  switch (provider) {
    case 'anthropic': {
      const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
    }

    case 'openai': {
      const url = baseUrl
        ? `${baseUrl.replace(/\/+$/, '')}/models`
        : 'https://api.openai.com/v1/models';
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id }));
    }

    case 'google': {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey ?? '')}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: { name: string; displayName?: string }[] };
      return (json.models ?? []).map((m) => ({
        id: m.name.replace(/^models\//, ''),
        name: m.displayName,
      }));
    }

    case 'mistral': {
      const res = await fetchWithTimeout('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string; name?: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id, name: m.name }));
    }

    case 'openrouter': {
      const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string; name?: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id, name: m.name }));
    }

    case 'ollama': {
      const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
      const res = await fetchWithTimeout(`${base}/api/tags`);
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: { name: string }[] };
      return (json.models ?? []).map((m) => ({ id: m.name }));
    }

    case 'openwebui': {
      const base = (baseUrl ?? 'http://localhost:3000/api/v1').replace(/\/+$/, '');
      const res = await fetchWithTimeout(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string }[] };
      return (json.data ?? []).map((m) => ({ id: m.id }));
    }

    default:
      return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Returns models from cache (if fresh) or live API. Falls back to empty array.
 */
export async function getModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<CachedModel[]> {
  const cache = readCache();
  const entry = cache.providers[provider];

  // Return cached if still within TTL
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.models;
  }

  // Try live fetch
  try {
    const models = await fetchModelsFromAPI(provider, apiKey, baseUrl);
    if (models.length > 0) {
      cache.providers[provider] = { fetchedAt: Date.now(), models };
      writeCache(cache);
      return models;
    }
  } catch { /* fetch failed */ }

  // Expired cache is better than nothing
  if (entry) return entry.models;

  return [];
}

/**
 * Fire-and-forget background cache refresh. Does not block.
 */
export function refreshCacheInBackground(
  provider: string,
  apiKey?: string,
  baseUrl?: string,
): void {
  fetchModelsFromAPI(provider, apiKey, baseUrl)
    .then((models) => {
      if (models.length > 0) {
        const cache = readCache();
        cache.providers[provider] = { fetchedAt: Date.now(), models };
        writeCache(cache);
      }
    })
    .catch(() => { /* silently ignore */ });
}

/**
 * Merge dynamic models with hardcoded fallback list, deduplicating by id.
 * Dynamic models come first, fallback entries are appended if not already present.
 */
export function mergeModels(
  dynamic: CachedModel[],
  fallback: { id: string; desc: string }[],
): { id: string; name?: string; desc?: string }[] {
  const seen = new Set<string>();
  const result: { id: string; name?: string; desc?: string }[] = [];

  for (const m of dynamic) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      // Enrich with desc from fallback if available
      const fb = fallback.find((f) => f.id === m.id);
      result.push({ id: m.id, name: m.name, desc: fb?.desc });
    }
  }

  for (const f of fallback) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      result.push({ id: f.id, desc: f.desc });
    }
  }

  return result;
}
