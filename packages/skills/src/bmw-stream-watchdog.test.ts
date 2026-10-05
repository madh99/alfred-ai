import { describe, it, expect } from 'vitest';
import { entscheideStreamWatchdog } from './bmw-stream-watchdog.js';

// v1176 — Realfall 04.10.: Reconnect um 11:57 geplant, nie gelaufen, Stream bis 19:46 tot.
const T = Date.parse('2026-10-04T09:57:00Z'); // 11:57 lokal

describe('entscheideStreamWatchdog', () => {
  it('deaktiviert / aktiv', () => {
    expect(entscheideStreamWatchdog({ enabled: false, aktiv: false }, T)).toBe('deaktiviert');
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: true }, T)).toBe('ok');
  });
  it('geplanter Reconnect innerhalb der Toleranz → warten; überfällig → Neustart (Realfall)', () => {
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: false, reconnectFaelligAt: T }, T + 60_000)).toBe('reconnect-ausstehend');
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: false, reconnectFaelligAt: T }, T + 10 * 60_000)).toBe('neustart');
  });
  it('ohne Reconnect-Planung: kurze Stille ok, lange Stille → Neustart', () => {
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: false, letztesEreignisAt: T }, T + 5 * 60_000)).toBe('reconnect-ausstehend');
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: false, letztesEreignisAt: T }, T + 20 * 60_000)).toBe('neustart');
    expect(entscheideStreamWatchdog({ enabled: true, aktiv: false }, T)).toBe('neustart');
  });
});
