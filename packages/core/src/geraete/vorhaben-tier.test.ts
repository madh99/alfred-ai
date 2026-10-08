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

import { VorhabenFreigaben, VORHABEN_GNADENFRIST_MS } from './freigaben.js';

describe('VorhabenFreigaben.verkuerze (v1297)', () => {
  it('verkürzt ein aktives Vorhaben auf die Gnadenfrist, nie verlängert es', () => {
    let t = 1_000_000;
    const f = new VorhabenFreigaben(() => t);
    const v = f.erzeuge('geraet_mac', { beschreibung: 'Rechner', aktionen: ['taste'], dauerMin: 60 });
    expect(f.aktiviere(v.nonce, 'geraet_mac')).toBeTruthy();
    const k = f.verkuerze(v.nonce);
    expect(k?.bis).toBe(t + VORHABEN_GNADENFRIST_MS);
    expect(f.aktive('geraet_mac')).toHaveLength(1);
    t += VORHABEN_GNADENFRIST_MS + 1;
    expect(f.aktive('geraet_mac')).toHaveLength(0);
    expect(f.verkuerze('gibt-es-nicht')).toBeUndefined();
  });
});
