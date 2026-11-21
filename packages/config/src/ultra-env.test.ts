import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigLoader } from './loader.js';

// v1923 (Spec Stufe ultra) — Realfall 21.11.: v1922 live, ALFRED_LLM_ULTRA_* gesetzt, aber keine Logzeile „LLM tier initialized … ultra“.
// Live-Konstellation wie auf .92: YAML mit Tiers + ENV-Flachschlüssel (ALFRED_LLM_PROVIDER/MODEL) → der Loader verschob jeden Schlüssel,
// der nicht in seiner Stufen-Liste stand, ins default-Tier; dort verwarf das Schema „ultra“.
const KEYS = ['ALFRED_LLM_PROVIDER', 'ALFRED_LLM_MODEL', 'ALFRED_LLM_API_KEY', 'ALFRED_LLM_ULTRA_PROVIDER', 'ALFRED_LLM_ULTRA_MODEL', 'ALFRED_LLM_ULTRA_API_KEY', 'ALFRED_LLM_STRONG_API_KEY'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function yaml(): string {
  const file = path.join(os.tmpdir(), `alfred-v1923-${process.pid}-${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(file, ['llm:', '  default:', '    provider: openai', '    model: gpt-6.1-sol', '  strong:', '    provider: anthropic', '    model: claude-opus-5-5', ''].join('\n'));
  return file;
}

describe('v1923 Stufe ultra aus ENV', () => {
  it('ALFRED_LLM_ULTRA_* landet in llm.ultra — auch mit ENV-Flachschlüsseln (Live-Konstellation)', () => {
    const file = yaml();
    process.env['ALFRED_LLM_PROVIDER'] = 'openai';
    process.env['ALFRED_LLM_MODEL'] = 'gpt-6.2-sol';
    process.env['ALFRED_LLM_ULTRA_PROVIDER'] = 'anthropic';
    process.env['ALFRED_LLM_ULTRA_MODEL'] = 'claude-fable-5-2';
    process.env['ALFRED_LLM_ULTRA_API_KEY'] = 'sk-ant-test-ultra';
    try {
      const llm = new ConfigLoader().loadConfig(file).llm as unknown as Record<string, { provider?: string; model?: string; apiKey?: string } | undefined>;
      expect(llm.ultra).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5-2', apiKey: 'sk-ant-test-ultra' });
      expect(llm.default?.model).toBe('gpt-6.2-sol');
      expect((llm.default as Record<string, unknown>).ultra).toBeUndefined();
      expect(llm.strong?.model).toBe('claude-opus-5-5');
    } finally { fs.rmSync(file, { force: true }); }
  });
});
