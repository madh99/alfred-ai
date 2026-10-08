import { describe, it, expect } from 'vitest';
import { istReparaturAktion } from '../vorgaenge/reparatur.js';

describe('v1315 istReparaturAktion — Reparaturen umgehen das Akzeptanzraten-Gate', () => {
  it('erkennt reauthorize (Realfall fam@dohnal.co) und Varianten', () => {
    expect(istReparaturAktion({ action: 'reauthorize', account: 'fam@dohnal.co' })).toBe(true);
    expect(istReparaturAktion({ action: 'Reconnect' })).toBe(true);
  });
  it('lässt gewöhnliche Aktionen durch das Gate', () => {
    expect(istReparaturAktion({ action: 'send' })).toBe(false);
    expect(istReparaturAktion({})).toBe(false);
    expect(istReparaturAktion(undefined)).toBe(false);
  });
});
