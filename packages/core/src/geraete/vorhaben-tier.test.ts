import { describe, it, expect } from 'vitest';
import { vorhabenTier, VORHABEN_TIER_STANDARD } from './freigaben.js';

describe('vorhabenTier (v1295)', () => {
  it('Standard ist fast', () => {
    expect(VORHABEN_TIER_STANDARD).toBe('fast');
    expect(vorhabenTier({})).toBe('fast');
    expect(vorhabenTier({ ALFRED_GERAETE_VORHABEN_TIER: '' })).toBe('fast');
  });
  it('nimmt gültige Tiers aus der Umgebung, Unsinn fällt auf fast zurück', () => {
    expect(vorhabenTier({ ALFRED_GERAETE_VORHABEN_TIER: 'default' })).toBe('default');
    expect(vorhabenTier({ ALFRED_GERAETE_VORHABEN_TIER: ' Strong ' })).toBe('strong');
    expect(vorhabenTier({ ALFRED_GERAETE_VORHABEN_TIER: 'embeddings' })).toBe('fast');
    expect(vorhabenTier({ ALFRED_GERAETE_VORHABEN_TIER: 'gpt' })).toBe('fast');
  });
});
