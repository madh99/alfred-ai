import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { frageOptionen } from './satellit.js';
import { argumenteFuer, auftragStand } from './satellit-auftrag.js';

/**
 * v1498 — Realfall 19.10. 09:08: Frage zum finanz-backend (Admin-UI/CLI durchdenken) brach mit error_max_budget_usd nach
 * 0,95 $ ohne Antwort ab — feste Grenze 0,50 $ aus v1432, entgegen der Owner-Regel vom 16.10. (keine Standard-Grenze).
 */
describe('v1498 Frage zum Projekt ohne feste Kostengrenze', () => {
  it('ohne Wunsch keine Grenze, der Titel ist die Frage des Owners', () => {
    expect(frageOptionen({}, 'Modell-Frage')).toEqual({ titel: 'Modell-Frage' });
    expect(frageOptionen({ titel: 'admin ui und cli durchdenken' }, 'Der Owner wünscht ausdrücklich …')).toEqual({ titel: 'admin ui und cli durchdenken' });
    expect(argumenteFuer({ prompt: 'P', nurLesen: true })).not.toContain('--max-budget-usd');
  });

  it('nur eine genannte Grenze gilt, höchstens 50 $', () => {
    expect(frageOptionen({ budget_usd: 2 }, 'f')).toEqual({ titel: 'f', budget: 2 });
    expect(frageOptionen({ budget_usd: 500 }, 'f').budget).toBe(50);
    expect(frageOptionen({ budget_usd: 0 }, 'f').budget).toBeUndefined();
    expect(frageOptionen({ budget_usd: '3' }, 'f').budget).toBeUndefined();
    const a = argumenteFuer({ prompt: 'P', nurLesen: true, maxKostenUsd: 2 });
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('2');
  });

  it('Zwischenstand nennt die Zahl der Schritte (für „arbeitet noch …“)', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-stand-'));
    const id = '20261019070815-test';
    const ordner = path.join(home, '.alfred', 'auftraege', id);
    mkdirSync(ordner, { recursive: true });
    writeFileSync(path.join(ordner, 'meta.json'), JSON.stringify({ id, titel: 'Frage: x', projekt: '/p', start: new Date(Date.now() - 125_000).toISOString(), status: 'laeuft', pid: 999_999_999, befehl: 'claude' }));
    const werkzeug = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    writeFileSync(path.join(ordner, 'log.txt'), [werkzeug('Read', { file_path: '/p/a.ts' }), werkzeug('Grep', { pattern: 'admin' }), werkzeug('Read', { file_path: '/p/b.ts' })].join('\n'));
    const s = auftragStand(id, home);
    expect(s.werkzeuge).toBe(3);
  });
});
