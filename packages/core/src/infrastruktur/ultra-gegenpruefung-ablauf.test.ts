import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchrittDaten, Einwand } from '@alfred/storage';
import { ChangePlanung, planAusChange } from './change-planung.js';
import { EinwandDienst } from './einwand.js';
import type { GegenpruefungVermerk, UltraBefund } from './ultra-gegenpruefung.js';

/**
 * Spec Stufe ultra U2.2 — Ablauf in freigabe_anfragen: Risiko high wird einmal von ultra gegengeprüft; Befunde werden
 * Einwände (Quelle ultra) mit Antwortpflicht; Risiko low bekommt keine Prüfung; unlesbar → keine Freigabe-Frage.
 */
const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, vmid: { type: 'number' }, name: { type: 'string' } }, required: ['action'] } } });
const SKILLS: Record<string, unknown> = { proxmox: skill('proxmox', ['vm_status', 'create_snapshot', 'delete_snapshot', 'list_vms']) };
const assets = [{ id: 'a-test', name: 'test-vm' }];
const keineAuswirkung = async (ids: string[]) => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] });
const plan = (risiko: string) => ({
  titel: `Snapshot ${risiko}`, begruendung: 'Probe für die Gegenprüfung', typ: 'normal', risiko, ausfallMinuten: 0, betroffen: ['test-vm'],
  schritte: [
    { titel: 'Zustand lesen', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 9001 } },
    { titel: 'Snapshot anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9001, name: 'p' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'p' }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 9001, name: 'p' } } },
  ],
});

function aufbau(antworten: Array<{ befunde: UltraBefund[] } | { fehler: string }>) {
  const db = new Map<string, CmdbChangeRequest>(); let n = 0;
  const aus = (d: ChangeSchrittDaten, id: string): CmdbChangeRequest => ({
    id, userId: 'o', title: d.title, description: d.description, type: d.type, status: 'submitted', riskLevel: d.riskLevel, affectedAssetIds: d.affectedAssetIds, affectedServiceIds: [],
    implementationPlan: d.implementationPlan, rollbackPlan: d.rollbackPlan, testPlan: d.testPlan, schritte: d.schritte, abhaengigVon: d.abhaengigVon, ausfallMinuten: d.ausfallMinuten,
    pruefung: d.pruefung, fingerabdruck: d.fingerabdruck, createdAt: 'x', updatedAt: 'x',
  });
  const itsm = {
    liste: async () => [...db.values()],
    hole: async (_o: string, id: string) => db.get(id) ?? null,
    legeAn: async (_o: string, d: ChangeSchrittDaten) => { const id = `chg-${String(++n).padStart(4, '0')}-0000`; db.set(id, aus(d, id)); return db.get(id)!; },
    setzeSchritte: async (_o: string, id: string, d: ChangeSchrittDaten) => { db.set(id, aus(d, id)); return db.get(id)!; },
    freigeben: async (_o: string, id: string) => db.get(id)!,
    setzeFreigabeAnfrage: async () => undefined,
  };
  const einwaende: Einwand[] = [];
  const einwand = new EinwandDienst({
    repo: {
      anlegen: async (_o, e) => { const x = { ...e, id: `ew-${einwaende.length + 1}-000000`, status: 'offen', erstellt: 'x' } as unknown as Einwand; einwaende.push(x); return x; },
      liste: async (_o, a, i) => einwaende.filter(e => e.zielArt === a && e.zielId === i),
      beantworte: async (_o, id, art, antwort) => { Object.assign(einwaende.find(e => e.id === id)!, { status: 'beantwortet', antwortArt: art, antwort }); },
      erledige: async () => undefined,
    },
    sperreChange: async (_o, id) => { db.get(id)!.status = 'draft'; return 'draft'; },
    sperreVorhaben: async () => 'entwurf',
  });
  const vermerke = new Map<string, GegenpruefungVermerk>();
  let aufrufe = 0;
  const fragen: string[] = [];
  const pl = new ChangePlanung({
    itsm: itsm as never, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: keineAuswirkung, einwand,
    bestaetigung: async f => { fragen.push(f.description); return true; },
    gegenpruefung: {
      pruefe: async () => { const r = antworten[aufrufe++]; if (!r) throw new Error('unerwarteter Aufruf'); return 'befunde' in r ? { ...r, modell: 'claude-fable-5-2' } : r; },
      vermerk: async (_o, id) => vermerke.get(id),
      setzeVermerk: async (_o, id, v) => { vermerke.set(id, v); },
    },
  });
  return { pl, db, einwaende, fragen, aufrufe: () => aufrufe };
}

describe('Spec Stufe ultra U2.2 — Gegenprüfung in freigabe_anfragen', () => {
  it('Risiko high mit Befunden: Einwände Quelle ultra, Entwurf, keine Frage; nach Antworten Frage mit Vermerk und Antworten, keine zweite Prüfung', async () => {
    const a = aufbau([{ befunde: [{ bezug: 'Schritt 2', text: 'Prüfung belegt den Snapshot nicht eindeutig' }] }]);
    const r = await a.pl.planen('o', [plan('hoch')]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const id = r.changes[0]!.id;
    const f1 = await a.pl.freigabeAnfragen('o', [id]);
    expect(f1.ok).toBe(false);
    if (!f1.ok) expect(f1.fehler.join('\n')).toContain('von ultra gegengeprüft — 1 Befund');
    expect(a.fragen).toHaveLength(0);
    expect(a.db.get(id)!.status).toBe('draft');
    expect(a.einwaende[0]).toMatchObject({ quelle: 'ultra', bezug: 'Schritt 2', status: 'offen' });
    // ohne Antwort nicht änderbar
    expect((await a.pl.aendern('o', id, planAusChange(a.db.get(id)!))).ok).toBe(false);
    const ae = await a.pl.aendern('o', id, planAusChange(a.db.get(id)!), [{ einwand: a.einwaende[0]!.id, art: 'abgelehnt', text: 'list_vms zeigt den Snapshot-Namen, reicht als Beleg' }]);
    expect(ae.ok).toBe(true);
    const f2 = await a.pl.freigabeAnfragen('o', [id]);
    expect(f2.ok).toBe(true);
    expect(a.aufrufe()).toBe(1); // einmal je Change
    expect(a.fragen[0]).toContain('Von ultra gegengeprüft: 1 Befund');
    expect(a.fragen[0]).toContain('Befunde der Gegenprüfung (ultra):');
    expect(a.fragen[0]).toContain('nicht umgesetzt: list_vms zeigt');
  });

  it('Vermerk gilt nur für den geprüften Plan: geänderter Plan → neu prüfen; ab der Grenze offen ausgewiesen', async () => {
    const a = aufbau([{ befunde: [] }, { befunde: [] }, { befunde: [] }]);
    const r = await a.pl.planen('o', [plan('hoch')]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const id = r.changes[0]!.id;
    const aendere = async (name: string) => { const p = plan('hoch'); (p.schritte[1]!.parameter as { name: string }).name = name; (p.schritte[1]!.pruefung as { erwartet: string }).erwartet = name; (p.schritte[1]!.rueckweg as { parameter: { name: string } }).parameter.name = name; expect((await a.pl.aendern('o', id, p)).ok).toBe(true); };
    expect((await a.pl.freigabeAnfragen('o', [id])).ok).toBe(true);
    expect(a.aufrufe()).toBe(1);
    await aendere('zwei');
    expect((await a.pl.freigabeAnfragen('o', [id])).ok).toBe(true);
    expect(a.aufrufe()).toBe(2);
    expect(a.fragen[1]).toContain('Von ultra gegengeprüft (2. Prüfung, nach Überarbeitung): keine Befunde.');
    await aendere('drei');
    expect((await a.pl.freigabeAnfragen('o', [id])).ok).toBe(true);
    await aendere('vier');
    expect((await a.pl.freigabeAnfragen('o', [id])).ok).toBe(true);
    expect(a.aufrufe()).toBe(3);
    expect(a.fragen[3]).toContain('diese Fassung ist NICHT gegengeprüft');
  });

  it('Risiko high ohne Befunde: Frage mit „keine Befunde“', async () => {
    const a = aufbau([{ befunde: [] }]);
    const r = await a.pl.planen('o', [plan('kritisch')]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect((await a.pl.freigabeAnfragen('o', [r.changes[0]!.id])).ok).toBe(true);
    expect(a.fragen[0]).toContain('Von ultra gegengeprüft: keine Befunde.');
  });

  it('Risiko low und medium: keine Gegenprüfung', async () => {
    const a = aufbau([]);
    const r = await a.pl.planen('o', [plan('niedrig'), plan('mittel')]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect((await a.pl.freigabeAnfragen('o', r.changes.map(c => c.id))).ok).toBe(true);
    expect(a.aufrufe()).toBe(0);
    expect(a.fragen[0]).not.toContain('ultra');
  });

  it('unlesbar: keine Frage, kein Vermerk, erneuter Aufruf prüft neu (fail-closed)', async () => {
    const a = aufbau([{ fehler: 'Antwort nicht lesbar' }, { befunde: [] }]);
    const r = await a.pl.planen('o', [plan('hoch')]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const f1 = await a.pl.freigabeAnfragen('o', [r.changes[0]!.id]);
    expect(f1.ok).toBe(false);
    if (!f1.ok) expect(f1.fehler.join('\n')).toContain('Gegenprüfung durch ultra nicht lesbar');
    expect(a.fragen).toHaveLength(0);
    expect((await a.pl.freigabeAnfragen('o', [r.changes[0]!.id])).ok).toBe(true);
    expect(a.aufrufe()).toBe(2);
  });
});
