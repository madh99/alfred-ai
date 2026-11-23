import { describe, it, expect } from 'vitest';
import { abgeschnittenGroesseresLimit } from '../message-pipeline.js';

/**
 * v1935 — Realfall 23.11.2026 10:19 (Faden infra, Eskalation auf ultra/claude-fable-5-2): dreimal 4096 und die
 * v1674-Wiederholung mit 16.384 Tokens gingen vollständig ins Thinking → „(no response)“. Seit v1934 streamt der
 * Anthropic-Provider große Limits, die 16.384-Deckelung (SDK-Grenze nicht-streamend) ist nicht mehr nötig.
 */
describe('v1935 — größeres Limit nach leerer Antwort am Ausgabelimit', () => {
  it('Modelle mit 128k Ausgabe bekommen 48.000', () => {
    expect(abgeschnittenGroesseresLimit(128_000)).toBe(48_000);
  });
  it('kleinere Modellgrenzen bleiben die Obergrenze', () => {
    expect(abgeschnittenGroesseresLimit(8_192)).toBe(8_192);
  });
  it('unbekannte Grenze → 48.000, nie unter 1024', () => {
    expect(abgeschnittenGroesseresLimit(undefined)).toBe(48_000);
    expect(abgeschnittenGroesseresLimit(100)).toBe(1024);
  });
});
