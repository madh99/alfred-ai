import { describe, it, expect } from 'vitest';
import { promptAbweichung } from './message-pipeline.js';

// v1702 — Messung: wo weicht der Prompt-Anfang zwischen zwei Nachrichten desselben Gesprächs ab?
describe('v1702 promptAbweichung', () => {
  const w = (n: string, d = 'x') => ({ name: n, description: d, inputSchema: { type: 'object' } });
  it('erste Nachricht ohne Vergleich; danach Position im System und erstes abweichendes Werkzeug', () => {
    const m = new Map();
    expect(promptAbweichung(m, 'c', '## Kern\nA\n## Zeit\n10:00', [w('a'), w('b')])).toEqual({});
    const r = promptAbweichung(m, 'c', '## Kern\nA\n## Zeit\n10:01', [w('a'), w('b', 'y')]) as { promptVergleich: Record<string, unknown> };
    expect(r.promptVergleich).toMatchObject({ werkzeugeGleich: false, ersteAbweichungWerkzeug: 1, werkzeugName: 'b', werkzeugArt: 'Inhalt' });
    const r2 = promptAbweichung(m, 'c', '## Kern\nA\n## Zeit\n10:02', [w('a'), w('b', 'y')]) as { promptVergleich: Record<string, unknown> };
    expect(r2.promptVergleich).toMatchObject({ werkzeugeGleich: true, systemGleichBis: '## Kern\nA\n## Zeit\n10:0'.length, systemAbschnitt: '## Zeit' });
    const r3 = promptAbweichung(m, 'c', '## Kern\nA\n## Zeit\n10:02', [w('b', 'y'), w('a')]) as { promptVergleich: Record<string, unknown> };
    expect(r3.promptVergleich).toMatchObject({ ersteAbweichungWerkzeug: 0, werkzeugArt: 'Reihenfolge' });
  });
});
