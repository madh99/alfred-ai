import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigLoader } from './loader.js';

// v1213 — Realfall 06.10.2026: ALFRED_LLM_TAGESBUDGET_USD gesetzt, Kachel ohne Budget.
// Live-Konstellation: YAML mit Tiers (default/strong/fast) UND ENV-Flachschlüssel
// (ALFRED_LLM_PROVIDER/MODEL) → Loader verschob alle Nicht-Tier-Schlüssel ins default-Tier.
const KEYS = ['ALFRED_LLM_PROVIDER', 'ALFRED_LLM_MODEL', 'ALFRED_LLM_TAGESBUDGET_USD', 'ALFRED_LLM_FAST_MODEL'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('Tagesbudget mit YAML-Tiers und ENV-Flachschlüsseln (v1213)', () => {
  it('llm.tagesbudgetUsd kommt an, default-Tier aus der YAML bleibt erhalten, ENV gewinnt', () => {
    const file = path.join(os.tmpdir(), `alfred-v1213-${process.pid}.yml`);
    fs.writeFileSync(file, [
      'llm:',
      '  default:',
      '    provider: anthropic',
      '    model: claude-sonnet-5',
      '    temperature: 0.7',
      '    maxTokens: 4096',
      '  strong:',
      '    provider: anthropic',
      '    model: claude-opus-5-5',
      '  fast:',
      '    provider: anthropic',
      '    model: claude-haiku-4-5-20251001',
      '',
    ].join('\n'));
    process.env['ALFRED_LLM_PROVIDER'] = 'openai';
    process.env['ALFRED_LLM_MODEL'] = 'gpt-6.1-sol';
    process.env['ALFRED_LLM_FAST_MODEL'] = 'claude-sonnet-5-5';
    process.env['ALFRED_LLM_TAGESBUDGET_USD'] = '10';
    try {
      const cfg = new ConfigLoader().loadConfig(file);
      const llm = cfg.llm as unknown as { tagesbudgetUsd?: number; default: { provider: string; model: string; temperature?: number; maxTokens?: number }; fast: { model: string }; strong: { model: string } };
      expect(llm.tagesbudgetUsd).toBe(10);
      expect(llm.default.provider).toBe('openai');
      expect(llm.default.model).toBe('gpt-6.1-sol');
      expect(llm.default.temperature).toBe(0.7);
      expect(llm.default.maxTokens).toBe(4096);
      expect(llm.fast.model).toBe('claude-sonnet-5-5');
      expect(llm.strong.model).toBe('claude-opus-5-5');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
