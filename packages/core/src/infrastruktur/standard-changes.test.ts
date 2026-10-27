import { describe, it, expect } from 'vitest';
import { StandardChanges } from './standard-changes.js';
import { VORLAGEN, hauptversionFest, snapshotAbgelaufen, snapshotName, vorlagenAbdruck, type StandardKontext } from './standard-vorlagen.js';
import { pruefeChangePlan, type PruefKontext } from './change-schritte.js';

// I4b Teil 4 — Standard-Changes (Owner 22.10. „Teil 4 wie vorgeschlagen“)
const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, vmid: { type: 'number' } }, required: ['action'] } } });
const SKILLS: Record<string, unknown> = {
  proxmox: skill('proxmox', ['vm_status', 'list_snapshots', 'create_snapshot', 'delete_snapshot', 'rollback_snapshot']),
  fernzugriff: skill('fernzugriff', ['lesen', 'ausfuehren']),
};
const pctx: PruefKontext = { skill: n => SKILLS[n] as never, asset: k => ({ id: k, name: k }), changes: [] };
const jetzt = new Date('2026-10-22T10:00:00Z');
const kontext = (o: Partial<StandardKontext> = {}): StandardKontext => ({
  jetzt,
  vm: async k => (k === 'test-ubuntu' || k === '142' ? { assetId: 'a-vm', vmid: 142, node: 'pve3', name: 'test-ubuntu' } : { fehler: `VM „${k}“ nicht gefunden` }),
  vmFuerZugang: async z => (z === 'docker1' ? { assetId: 'a-vm2', vmid: 150, node: 'pve1', name: 'docker1' } : undefined),
  zugangAsset: async z => `a-${z}`,
  container: (_z, n) => ({ noah: { image: 'ghcr.io/x/noah:2.1', zustand: 'running', gesundheit: 'unhealthy', composeProjekt: 'noah', composeDienst: 'web', composeDatei: '/opt/noah/docker-compose.yml' }, pg: { image: 'postgres:16', zustand: 'running', gesundheit: 'healthy', composeProjekt: 'db', composeDienst: 'pg', composeDatei: '/opt/db/c.yml' }, neu: { image: 'x/neu:latest', zustand: 'running', gesundheit: 'healthy', composeProjekt: 'n', composeDienst: 'n', composeDatei: '/opt/n/c.yml' } } as Record<string, ReturnType<StandardKontext['container']>>)[n],
  snapshots: async () => [{ name: 'alfred_20261010_7d' }, { name: 'alfred_20261020_7d' }, { name: 'vor-update' }],
  updatesAn: async z => z === 'docker1',
  anzahl: async () => 0,
  ...o,
});
const V = (k: string) => VORLAGEN.find(v => v.key === k)!;

describe('I4b Standard-Vorlagen', () => {
  it('Hilfen: Snapshot-Namen, Ablauf, Hauptversion', () => {
    expect(snapshotName(jetzt, 7)).toBe('alfred_20261022_7d');
    expect(snapshotAbgelaufen('alfred_20261010_7d', jetzt)).toBe(true);
    expect(snapshotAbgelaufen('alfred_20261020_7d', jetzt)).toBe(false);
    expect(snapshotAbgelaufen('vor-update', jetzt)).toBe(false);
    expect(hauptversionFest('ghcr.io/x/noah:2.1')).toBe(true);
    expect(hauptversionFest('x/neu:latest')).toBe(false);
    expect(hauptversionFest('nginx')).toBe(false);
  });
  it('jede erzeugte Vorlage besteht die normale Planprüfung', async () => {
    for (const [k, p] of [['snapshot_anlegen', { vm: 'test-ubuntu', tage: 7 }], ['snapshot_aufraeumen', { vm: '142' }], ['sicherheitsupdates', { zugang: 'docker1' }], ['image_aktualisieren', { zugang: 'dockerhost', container: 'noah' }], ['neustart_unhealthy', { zugang: 'dockerhost', container: 'noah' }]] as const) {
      const e = await V(k).erzeuge!(p, kontext());
      expect('plan' in e, `${k}: ${'fehler' in e ? e.fehler : ''}`).toBe(true);
      if ('plan' in e) expect(pruefeChangePlan(e.plan, pctx).fehler, k).toEqual([]);
    }
  });
  it('Grenzen: Haltbarkeit, Schalter aus, kein VM-Snapshot, DB/HA, latest, nicht unhealthy, 1× je Tag, nur eigene abgelaufene Snapshots', async () => {
    const f = async (k: string, p: Record<string, unknown>, o?: Partial<StandardKontext>) => { const e = await V(k).erzeuge!(p, kontext(o)); return 'fehler' in e ? e.fehler : 'ok'; };
    expect(await f('snapshot_anlegen', { vm: 'test-ubuntu', tage: 30 })).toBe('tage 1–14');
    expect(await f('sicherheitsupdates', { zugang: 'pve' })).toContain('Schalter „Sicherheitsupdates“ ist für pve aus');
    expect(await f('sicherheitsupdates', { zugang: 'pve' }, { updatesAn: async () => true })).toContain('läuft nicht als Proxmox-VM');
    expect(await f('image_aktualisieren', { zugang: 'h', container: 'pg' })).toContain('Datenbanken');
    expect(await f('image_aktualisieren', { zugang: 'h', container: 'neu' })).toContain('keine festgelegte Hauptversion');
    expect(await f('neustart_unhealthy', { zugang: 'h', container: 'neu' })).toContain('nicht unhealthy');
    expect(await f('neustart_unhealthy', { zugang: 'h', container: 'noah' }, { anzahl: async () => 1 })).toContain('höchstens 1× je Tag');
    const auf = await V('snapshot_aufraeumen').erzeuge!({ vm: '142' }, kontext());
    expect('plan' in auf && (auf.plan.schritte as Array<{ parameter: { name: string } }>).map(s => s.parameter.name)).toEqual(['alfred_20261010_7d']);
  });
});

describe('I4b Standard-Freigabe', () => {
  it('nur über das Ja, an die Vorlage gebunden, widerrufbar; ohne Freigabe kein Change', async () => {
    const db = new Map<string, { vorlage: string; abdruck: string; status: string; frageHash?: string; frageBis?: string }>();
    let frage: Record<string, unknown> | undefined; let gespeichert = 0;
    const vorlagen = VORLAGEN.map(v => ({ ...v }));
    const st = new StandardChanges({
      vorlagen,
      stand: async () => [...db.values()],
      setze: async (_o, v, d) => { db.set(v, { vorlage: v, abdruck: d.abdruck, status: d.status, ...(d.frageHash ? { frageHash: d.frageHash } : {}), ...(d.frageBis ? { frageBis: d.frageBis } : {}) }); },
      kontext: async () => kontext(),
      speichere: async () => { gespeichert++; return { ok: true, change: { id: 'c1', title: 't', status: 'approved' } as never }; },
      frage: async (_d, p) => { frage = p; return true; },
    });
    expect((await st.anlegen('o', 'snapshot_anlegen', { vm: 'test-ubuntu' })).ok).toBe(false);
    expect(await st.freigabeAnfragen('o', 'vorlage_neu_bauen')).toContain('folgt mit I5');
    await st.freigabeAnfragen('o', 'snapshot_anlegen');
    expect((await st.freigebenNachJa('o', 'snapshot_anlegen', 'erfunden')).ok).toBe(false);
    expect((await st.freigebenNachJa('o', 'snapshot_anlegen', frage!.freigabe)).ok).toBe(true);
    expect((await st.anlegen('o', 'snapshot_anlegen', { vm: 'test-ubuntu' })).ok).toBe(true);
    expect(gespeichert).toBe(1);
    // Vorlage geändert → Freigabe verfällt
    vorlagen.find(v => v.key === 'snapshot_anlegen')!.beschreibung += ' (erweitert)';
    expect((await st.liste('o')).find(v => v.key === 'snapshot_anlegen')!.zustand).toContain('neue Freigabe nötig');
    expect((await st.anlegen('o', 'snapshot_anlegen', { vm: 'test-ubuntu' })).ok).toBe(false);
    await st.widerrufen('o', 'snapshot_anlegen');
    expect((await st.liste('o')).find(v => v.key === 'snapshot_anlegen')!.zustand).toBe('widerrufen');
    expect(vorlagenAbdruck(V('snapshot_anlegen'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

// S1 (Spec 2026-10-27-standard-changes-eingangskontrolle) — Annahmen, Eingangskontrolle, Sperre, Verfall, Zähler
describe('S1 Eingangskontrolle und Sperre', () => {
  const aufbau = (o: { pruefe?: (p: { befehl?: string; aktion?: string }) => { ok: boolean; text: string }; laeufe?: { anzahl: number; letzter?: string }; jetztMs?: number } = {}) => {
    const db = new Map<string, { vorlage: string; abdruck: string; status: string; freigegebenAt?: string }>();
    const v = V('sicherheitsupdates');
    db.set(v.key, { vorlage: v.key, abdruck: vorlagenAbdruck(v), status: 'freigegeben', freigegebenAt: '2026-10-20T00:00:00Z' });
    const gespeichert: Array<Record<string, unknown>> = []; const meldungen: string[] = [];
    const st = new StandardChanges({
      stand: async () => [...db.values()],
      setze: async (_o, k, d) => { db.set(k, { ...db.get(k)!, abdruck: d.abdruck, status: d.status }); },
      kontext: async () => kontext(),
      speichere: async (_o, plan) => { gespeichert.push(plan); return { ok: true, change: { id: 'c1', title: 't', status: 'approved' } as never }; },
      pruefe: async p => (o.pruefe ?? (() => ({ ok: true, text: 'ok' })))(p as never),
      laeufe: async () => o.laeufe ?? { anzahl: 0 },
      melde: async t => { meldungen.push(t); },
      jetzt: () => o.jetztMs ?? Date.parse('2026-10-28T10:00:00Z'),
    });
    return { st, db, gespeichert, meldungen };
  };

  it('Annahmen gehen in den Abdruck; erzeugter Plan mit Eingangskontroll-Schritten besteht die Planprüfung', async () => {
    const v = V('sicherheitsupdates');
    expect(vorlagenAbdruck({ ...v, annahmenText: [...v.annahmenText!, 'neu'] })).not.toBe(vorlagenAbdruck(v));
    const t = aufbau();
    expect((await t.st.anlegen('o', 'sicherheitsupdates', { zugang: 'docker1' })).ok).toBe(true);
    const schritte = t.gespeichert[0]!.schritte as Array<{ titel: string; art: string }>;
    expect(schritte.slice(0, 4).map(s => s.titel)).toEqual(['Eingangskontrolle: Debian-artiges System (apt)', 'Eingangskontrolle: unattended-upgrades ist installiert', 'Eingangskontrolle: keine Paketverwaltung blockiert (dpkg sauber)', 'Eingangskontrolle: Gast-Agent der VM antwortet']);
    expect(schritte[4]!.titel).toMatch(/^Snapshot/);
    expect(pruefeChangePlan(t.gespeichert[0]!, pctx).fehler).toEqual([]);
  });

  it('abweichende Annahme → kein Change, Meldung mit der Abweichung', async () => {
    const t = aufbau({ pruefe: p => (p.befehl?.includes('os-release') ? { ok: false, text: '„debian“ nicht gefunden (ID=fedora)' } : { ok: true, text: 'ok' }) });
    const r = await t.st.anlegen('o', 'sicherheitsupdates', { zugang: 'docker1' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fehler[0]).toContain('Debian-artiges System (apt): „debian“ nicht gefunden');
    expect(t.gespeichert).toHaveLength(0);
    expect(t.meldungen[0]).toContain('Eingangskontrolle weicht ab');
  });

  it('Sperre nach Halt: überprüfen, kein Anlegen mehr, neue Freigabe nötig; Liste zeigt Zähler', async () => {
    const t = aufbau({ laeufe: { anzahl: 3, letzter: '2026-10-27T01:00:00Z' } });
    expect(await t.st.sperre('o', 'sicherheitsupdates', 'I9 – 149 angehalten')).toBe(true);
    expect(await t.st.sperre('o', 'sicherheitsupdates', 'nochmal')).toBe(false); // schon gesperrt, keine zweite Meldung
    expect(t.meldungen).toHaveLength(1);
    const r = await t.st.anlegen('o', 'sicherheitsupdates', { zugang: 'docker1' });
    expect(!r.ok && r.fehler[0]).toContain('gesperrt (überprüfen)');
    const z = (await t.st.liste('o')).find(v => v.key === 'sicherheitsupdates')!;
    expect(z.zustand).toContain('überprüfen');
    expect(z).toMatchObject({ laeufe: 3, letzterLauf: '2026-10-27T01:00:00Z' });
    expect(z.annahmen).toHaveLength(4);
  });

  it('Verfall: über 2 Monate ohne Lauf → gesperrt; letzter Lauf zählt vor der Freigabe', async () => {
    const alt = aufbau({ jetztMs: Date.parse('2027-01-05T00:00:00Z') });
    const r = await alt.st.anlegen('o', 'sicherheitsupdates', { zugang: 'docker1' });
    expect(!r.ok && r.fehler[0]).toContain('über 2 Monate ohne Lauf');
    expect(alt.db.get('sicherheitsupdates')!.status).toBe('ueberpruefen');
    const frisch = aufbau({ jetztMs: Date.parse('2027-01-05T00:00:00Z'), laeufe: { anzahl: 5, letzter: '2026-12-30T01:00:00Z' } });
    expect((await frisch.st.anlegen('o', 'sicherheitsupdates', { zugang: 'docker1' })).ok).toBe(true);
  });
});
