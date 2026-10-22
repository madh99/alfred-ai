import { describe, it, expect } from 'vitest';
import type { Einwand } from '@alfred/storage';
import { EinwandDienst } from './einwand.js';
import { neinGrund } from '../confirmation-queue.js';

// Einwand (Owner 22.10.) — Widerspruch mit Pflicht zur Antwort
function dienst() {
  const db: Einwand[] = []; const gesperrt: string[] = [];
  const d = new EinwandDienst({
    repo: {
      anlegen: async (_o, e) => { const x: Einwand = { id: `e${db.length + 1}-0000`, ...e, status: 'offen', erstellt: 'jetzt' }; db.push(x); return x; },
      liste: async (_o, a, i) => db.filter(x => x.zielArt === a && x.zielId === i),
      beantworte: async (_o, id, art, antwort) => { const x = db.find(y => y.id === id)!; Object.assign(x, { status: 'beantwortet', antwortArt: art, antwort }); },
      erledige: async (_o, ids) => { for (const x of db) if (ids.includes(x.id) && x.status === 'beantwortet') x.status = 'erledigt'; },
    },
    sperreChange: async (_o, id) => { gesperrt.push(id); return 'draft'; },
    sperreVorhaben: async () => 'entwurf',
  });
  return { d, db, gesperrt };
}

describe('Einwand', () => {
  it('erfassen sperrt; Überarbeitung nur mit Antwort auf jeden offenen Einwand; Freigabe-Text; erledigen', async () => {
    const { d, db, gesperrt } = dienst();
    await expect(d.erfasse('o', { zielArt: 'change', zielId: 'c1', text: ' ', quelle: 'chat' })).rejects.toThrow('braucht einen Text');
    const a = await d.erfasse('o', { zielArt: 'change', zielId: 'c1', bezug: 'Schritt 4', text: 'nicht während der Bürozeit', quelle: 'chat' });
    await d.erfasse('o', { zielArt: 'change', zielId: 'c1', text: 'Rückweg fehlt beim DNS', quelle: 'web' });
    expect(gesperrt).toEqual(['c1', 'c1']);
    expect(a.einwand.bezug).toBe('Schritt 4');
    const ohne = await d.pruefeAntworten('o', 'change', 'c1', []);
    expect(ohne.fehler.length).toBe(2);
    const halb = await d.pruefeAntworten('o', 'change', 'c1', [{ einwand: 'e1-0000', art: 'umgesetzt', text: 'Wartungsfenster nachts gesetzt' }]);
    expect(halb.fehler.length).toBe(1);
    expect(halb.fehler[0]).toContain('Rückweg fehlt beim DNS');
    const ganz = await d.pruefeAntworten('o', 'change', 'c1', [{ einwand: 'e1-0000', art: 'umgesetzt', text: 'Wartungsfenster nachts gesetzt' }, { einwand: 'e2-0000', art: 'abgelehnt', text: 'DNS ändert sich nicht, nur das NPM-Ziel' }]);
    expect(ganz.fehler).toEqual([]);
    await d.speichereAntworten('o', ganz.antworten);
    const t = await d.antwortText('o', 'change', 'c1');
    expect(t).toContain('Schritt 4: „nicht während der Bürozeit“ → umgesetzt: Wartungsfenster nachts gesetzt');
    expect(t).toContain('→ nicht umgesetzt: DNS ändert sich nicht');
    await d.erledigeBeantwortete('o', 'change', 'c1');
    expect(db.map(x => x.status)).toEqual(['erledigt', 'erledigt']);
    expect((await d.pruefeAntworten('o', 'change', 'c1', undefined)).fehler).toEqual([]);
  });
  it('Grund aus „nein, weil …“', () => {
    expect(neinGrund('nein')).toBeUndefined();
    expect(neinGrund('Nein, weil Schritt 4 zu früh ist')).toBe('Schritt 4 zu früh ist');
    expect(neinGrund('nö — lieber am Wochenende')).toBe('lieber am Wochenende');
    expect(neinGrund('nein!')).toBeUndefined();
  });
});
