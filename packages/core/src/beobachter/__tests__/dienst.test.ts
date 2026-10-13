import { describe, it, expect } from 'vitest';
import { BeobachterDienst, type BeobachterRepo, type GeraetStand } from '../dienst.js';
import type { RegelLike } from '../regeln.js';

function aufbau(geraete: GeraetStand[] = [{ id: 'g1', name: 'PC-madh', online: true }]) {
  const regeln = new Map<string, RegelLike>();
  const arten: Record<string, string[]> = {};
  const uhr = { jetzt: Date.now() };
  let nr = 0;
  const repo: BeobachterRepo = {
    liste: async () => [...regeln.values()],
    hole: async (_u, id) => regeln.get(id) ?? null,
    anlegen: async (e) => { const r = { ...e, id: `r${++nr}`, treffer: 0 } as RegelLike; regeln.set(r.id, r); return r; },
    aendern: async (_u, id, p) => { const r = regeln.get(id); if (!r) return null; const n = { ...r, ...p }; regeln.set(id, n); return n; },
    loeschen: async (_u, id) => regeln.delete(id),
    treffer: async (id) => { const r = regeln.get(id); if (r) r.treffer = (r.treffer ?? 0) + 1; },
    artenAus: async () => ({ ...arten }), // v1433
    setzeArtenAus: async (_u, g, a) => { if (a.length) arten[g] = a; else delete arten[g]; },
  };
  const gesendet: Array<{ geraetId: string; n: Record<string, unknown> }> = [];
  const meldungen: string[] = [];
  const vorgaenge: Array<Record<string, unknown>> = [];
  const aufgaben: Array<{ auftrag: string; ausloeser: string; skills: string[] }> = [];
  const bestaetigungen: string[] = [];
  let befunde: unknown[] = [];
  const d = new BeobachterDienst({
    repo, owner: () => 'o1', geraete: async () => geraete, projekte: async () => [{ id: 'p1', name: 'Angebots-Radar' }],
    sendeAn: (geraetId, n) => { gesendet.push({ geraetId, n }); return true; }, geraetSkillName: (n) => `geraet_${n.toLowerCase().replace(/-/g, '_')}`,
    melde: async (t) => { meldungen.push(t); }, vorgang: async (e) => { vorgaenge.push(e); },
    aufgabe: async (_r, auftrag, ausloeser, skills) => { aufgaben.push({ auftrag, ausloeser, skills }); },
    bestaetigung: async (_r, b) => { bestaetigungen.push(b); return true; },
    befundeSync: async (b) => { befunde = b; }, logger: { info: () => undefined, warn: () => undefined }, jetzt: () => uhr.jetzt,
  });
  return { d, uhr, arten, regeln, gesendet, meldungen, vorgaenge, aufgaben, bestaetigungen, befunde: () => befunde };
}
const t = (regel: string, schluessel: string, name = 'rechnung.pdf') => ({ regel, quelle: 'ordner', art: 'neu', schluessel, zeit: '', kopf: { name, relativ: name, groesse: 2048 } });

describe('v1429 R4a Beobachter-Dienst', () => {
  it('Anlegen schickt dem Gerät seine aktiven Regeln; Aus schickt eine leere Liste', async () => {
    const a = aufbau();
    const r = await a.d.anlegen({ geraet: 'PC-madh', pfad: 'C:\\Users\\madh\\Downloads', muster: '*.pdf', wirkung: 'hinweis', name: 'Rechnungen' });
    expect(r.success).toBe(true);
    expect(a.gesendet.at(-1)).toMatchObject({ geraetId: 'g1', n: { typ: 'beobachten', regeln: [{ quelle: 'ordner', muster: '*.pdf' }] } });
    await a.d.aendern('r1', { aktion: 'aus' });
    expect(a.gesendet.at(-1)!.n.regeln).toEqual([]);
  });

  it('Wirkungen: Hinweis, Vorgang, Aufgabe mit Werkzeugliste, Projekt nur mit Bestätigung; Dubletten und fremde Regeln nicht', async () => {
    const a = aufbau();
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'hinweis', name: 'H' });
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'vorgang', name: 'V', auftrag: 'Rechnung prüfen und ablegen' });
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'aufgabe', name: 'A', auftrag: 'Fasse die Rechnung zusammen' });
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'projekt', name: 'P', auftrag: 'Importiere die neue Preisliste', projekt: 'angebots' });
    expect(await a.d.verarbeite('g1', [t('r1', 'k1'), t('r1', 'k1'), t('r2', 'k2'), t('r3', 'k3'), t('r4', 'k4'), t('r1', 'k5')])).toBe(5);
    expect(a.meldungen[0]).toContain('Neue Datei auf PC-madh: rechnung.pdf');
    expect(a.vorgaenge[0]).toMatchObject({ titel: 'V: rechnung.pdf', naechsterSchritt: 'Rechnung prüfen und ablegen', dedupeKey: 'beobachtung:r2:k2' });
    expect(a.aufgaben[0]).toMatchObject({ auftrag: 'Fasse die Rechnung zusammen', skills: ['geraet_pc_madh', 'todo', 'reminder', 'memory', 'note'] });
    expect(a.bestaetigungen[0]).toContain('Projekt weiterarbeiten: Importiere die neue Preisliste?');
    expect(await a.d.verarbeite('g2', [t('r1', 'k9')])).toBe(0); // Regel gehört zu g1
    expect(a.regeln.get('r1')!.treffer).toBe(2);
  });

  it('Drossel: mehr als 20 Treffer je Stunde → einmal melden, Rest nur zählen', async () => {
    const a = aufbau();
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'hinweis', name: 'H' });
    await a.d.verarbeite('g1', Array.from({ length: 25 }, (_, i) => t('r1', `k${i}`)));
    expect(a.meldungen.filter(m => m.startsWith('🔭 Neue Datei'))).toHaveLength(20);
    expect(a.meldungen.filter(m => m.includes('mehr als 20 Treffer'))).toHaveLength(1);
    expect(a.regeln.get('r1')!.treffer).toBe(25);
  });

  it('Liste zeigt den Stand am Gerät; Wächter meldet Störungen als Befund', async () => {
    const g: GeraetStand[] = [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: new Date().toISOString(), sinne: { beobachter: [{ regel: 'r1', zustand: 'gestoert', grund: 'Ordner fehlt' }] } }];
    const a = aufbau(g);
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'hinweis', name: 'H' });
    expect((await a.d.liste()).regeln[0]).toMatchObject({ stand: 'gestört', standGrund: 'Ordner fehlt' });
    expect(await a.d.waechter()).toBe(1);
    expect(a.befunde()).toEqual([{ gegenstand: 'g1:r1', titel: 'Beobachter „H" auf PC-madh gestört: Ordner fehlt' }]);
  });
});

describe('v1430 Outlook nur für Konten, die der Server nicht liest', () => {
  it('alle Konten vom Server gelesen → ohne Wirkung, Treffer verworfen', async () => {
    const g: GeraetStand[] = [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: new Date().toISOString(), sinne: { beobachter: [{ regel: 'r1', zustand: 'laeuft', konten: ['dohnalmarkus81@gmail.com'] }] } }];
    const a = aufbau(g);
    (a.d as unknown as { d: { serverMailKonten: () => string[] } }).d.serverMailKonten = () => ['DohnalMarkus81@gmail.com'];
    await a.d.anlegen({ geraet: 'g1', quelle: 'outlook', wirkung: 'hinweis', name: 'O' });
    expect((await a.d.liste()).regeln[0]).toMatchObject({ stand: 'ohne Wirkung' });
    expect(await a.d.verarbeite('g1', [{ regel: 'r1', quelle: 'outlook', art: 'neu', schluessel: 'x', zeit: '', kopf: { von: 'a', betreff: 'b' } }])).toBe(0);
    expect(a.meldungen).toEqual([]);
  });
});

describe('v1433 B10/B11 Schalter je Gerät und Art, einmalig/bis', () => {
  it('Art am Gerät aus: Nutzlast ohne diese Regeln, Stand „Art am Gerät aus“, Treffer verworfen; wieder an → zurück', async () => {
    const a = aufbau();
    await a.d.anlegen({ geraet: 'PC-madh', pfad: '/d', wirkung: 'hinweis', name: 'Ordner' });
    await a.d.anlegen({ geraet: 'PC-madh', quelle: 'benachrichtigung', apps: ['WhatsApp'], wirkung: 'hinweis' });
    const aus = await a.d.anlegen({ aktion: 'geraet_art', geraet: 'pc-madh', quelle: 'ordner', an: false });
    expect(aus).toMatchObject({ success: true, display: 'Ordner auf PC-madh: ausgeschaltet — dort läuft keine Regel dieser Art.' });
    expect((a.gesendet.at(-1)!.n.regeln as Array<{ quelle: string }>).map(r => r.quelle)).toEqual(['benachrichtigung']);
    const l = await a.d.liste();
    expect(l.regeln[0]).toMatchObject({ stand: 'Art am Gerät aus' });
    expect(l.geraete[0]).toMatchObject({ artenAus: ['ordner'] });
    expect(await a.d.verarbeite('g1', [t('r1', 'k1')])).toBe(0);
    await a.d.geraetArt({ geraet: 'g1', quelle: 'ordner', an: true });
    expect(a.gesendet.at(-1)!.n.regeln).toHaveLength(2);
    expect(await a.d.verarbeite('g1', [t('r1', 'k2')])).toBe(1);
    expect((await a.d.geraetArt({ geraet: 'g1', quelle: 'mail', an: false })).success).toBe(false);
  });

  it('einmalig: erster Treffer wirkt, dann aus mit Meldung „erledigt“, Gerät bekommt leere Liste', async () => {
    const a = aufbau();
    await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'hinweis', name: 'Sobald', einmalig: true });
    expect(await a.d.verarbeite('g1', [t('r1', 'k1'), t('r1', 'k2')])).toBe(1);
    expect(a.regeln.get('r1')!.aktiv).toBe(false);
    expect(a.meldungen.at(-1)).toContain('ist jetzt aus (einmalig) — erledigt');
    expect(a.gesendet.at(-1)!.n.regeln).toEqual([]);
  });

  it('bis: Dauer in Tagen, danach abgelaufen — Wächter schaltet ab und meldet', async () => {
    const a = aufbau();
    const r = await a.d.anlegen({ geraet: 'g1', pfad: '/d', wirkung: 'hinweis', name: 'Drei Tage', tage: 3 });
    expect(r.display).toContain(', bis ');
    expect(a.regeln.get('r1')!.bis).toBe(new Date(Date.parse(a.regeln.get('r1')!.bis!)).toISOString());
    a.uhr.jetzt += 3 * 86_400_000 + 1000;
    expect(await a.d.verarbeite('g1', [t('r1', 'k1')])).toBe(0);
    expect((await a.d.liste()).regeln[0]).toMatchObject({ stand: 'abgelaufen' });
    await a.d.waechter();
    expect(a.regeln.get('r1')!.aktiv).toBe(false);
    expect(a.meldungen.at(-1)).toContain('ist abgelaufen und jetzt aus');
    expect((await a.d.anlegen({ geraet: 'g1', pfad: '/d', bis: '2020-01-01T00:00:00Z' })).error).toBe('bis liegt in der Vergangenheit');
  });
});
