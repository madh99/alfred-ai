import { describe, it, expect } from 'vitest';
import { knappesInsight, knappeFassung, KNAPP_MAX_INSIGHTS } from '../interaktion/knapp.js';

// v1203 — Jarvis Interaktion: Standard knapp. Realfall 05.10. 23:31: vier Insights mit Absätzen und Unterpunkten.
const REAL = `4. **⚠️ Proxmox-Server \`git-server\` RAM-Auslastung 95,1%**
   - **Jetzt prüfen: Swap-Nutzung, Prozesse killen oder Ressourcen erweitern** – Beeinträchtigt fussball-cc-Projekt (git-Verifizierung).
   *→ Betrifft: VM \`git-server\` (RAM 95,1%, Trend: -58% in 4 Wochen).*`;

describe('knappesInsight', () => {
  it('Titel plus ein Folgesatz, ohne Nummer, Markdown und Schweregrad', () => {
    const k = knappesInsight(REAL);
    expect(k.startsWith('⚠️ Proxmox-Server `git-server` RAM-Auslastung 95,1% — Jetzt prüfen: Swap-Nutzung, Prozesse killen oder Ressourcen erweitern')).toBe(true);
    expect(k).not.toContain('**');
    expect(k).not.toContain('Betrifft');
    expect(k.length).toBeLessThanOrEqual(240);
  });
  it('nur Titel, wenn es keinen Folgetext gibt', () => {
    expect(knappesInsight('1. **[HIGH] Stromausfall gemeldet**')).toBe('Stromausfall gemeldet');
  });
});

describe('knappeFassung', () => {
  it('höchstens fünf Zeilen, Rest als Hinweis auf die Kachel', () => {
    const f = knappeFassung(Array.from({ length: 7 }, (_, i) => `**Thema ${i + 1}**\n- Erster Satz zu Thema ${i + 1}. Zweiter Satz, der wegfällt.`));
    const zeilen = f.text.split('\n');
    expect(zeilen).toHaveLength(KNAPP_MAX_INSIGHTS + 1);
    expect(zeilen[0]).toBe('1. Thema 1 — Erster Satz zu Thema 1.');
    expect(zeilen[5]).toBe('… und 2 weitere (Kachel Vorgänge)');
    expect(f.weggelassen).toBe(2);
  });
  it('ein einzelnes Insight bleibt ohne Nummer', () => {
    expect(knappeFassung(['**Alles ruhig**\nKeine Auffälligkeiten.']).text).toBe('Alles ruhig — Keine Auffälligkeiten.');
  });
});
