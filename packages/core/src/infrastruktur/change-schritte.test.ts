import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchrittDaten } from '@alfred/storage';
import { aktionsArt, changeFingerabdruck, plaeneAusSchritten, pruefeChangePlan, zyklus, type PruefKontext, type ChangeSchritt } from './change-schritte.js';
import { ChangePlanung, planAusChange, FREIGABE_FRAGE_GUELTIG_MS } from './change-planung.js';

// I3 — Changes mit Schritten: Prüfung beim Anlegen, Fingerabdruck, Paket, Owner-Freigabe
const skill = (name: string, aktionen: string[], props: Record<string, { type?: string }> = {}, pruefe?: (i: Record<string, unknown>) => string | undefined) =>
  ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, ...props }, required: ['action'] } }, ...(pruefe ? { pruefeEingabe: pruefe } : {}) });
const SKILLS: Record<string, ReturnType<typeof skill>> = {
  proxmox: skill('proxmox', ['list_vms', 'vm_status', 'create_snapshot', 'delete_snapshot', 'rollback_snapshot', 'clone_vm', 'start_vm', 'stop_vm', 'delete_vm'], { vmid: { type: 'number' }, name: { type: 'string' } }, i => (['create_snapshot', 'vm_status', 'start_vm', 'stop_vm', 'delete_snapshot', 'rollback_snapshot'].includes(String(i.action)) && i.vmid === undefined ? `${i.action} braucht vmid oder vm (Name)` : undefined)),
  nginx_proxy_manager: skill('nginx_proxy_manager', ['list_hosts', 'create_host', 'update_host', 'delete_host']),
  fernzugriff: skill('fernzugriff', ['lesen', 'ausfuehren', 'kopieren', 'geheim_uebernehmen'], { name: { type: 'string' }, befehl: { type: 'string' }, pfad: { type: 'string' }, tresor_name: { type: 'string' }, quelle: { type: 'string' }, ziel: { type: 'string' }, quelle_pfad: { type: 'string' }, ziel_pfad: { type: 'string' } }),
  itsm: skill('itsm', ['approve_change']),
};
const assets = [{ id: 'a-pve', name: 'pve' }, { id: 'a-dh', name: 'dockerhost' }, { id: 'a-dh2', name: 'dockerhost' }, { id: 'a-test', name: 'test-vm' }];
const ctx = (changes: PruefKontext['changes'] = []): PruefKontext => ({
  skill: n => SKILLS[n] as never,
  asset: k => { if (assets.some(a => a.id === k)) return assets.find(a => a.id === k)!; const t = assets.filter(a => a.name === k); return t.length > 1 ? { mehrdeutig: t.map(a => a.id) } : t[0]; },
  changes, jetzt: new Date('2026-10-22T10:00:00Z'),
});
const snapshotChange = () => ({
  titel: 'Snapshot-Probe test-vm', begruendung: 'Harmloser Probe-Change für den Ausführungsmotor', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['test-vm'],
  schritte: [
    { titel: 'Zustand lesen', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 9001 } },
    { titel: 'Snapshot anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9001, name: 'i3probe' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'i3probe' }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 9001, name: 'i3probe' } } },
    { titel: 'Snapshot löschen', art: 'aktion', skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 9001, name: 'i3probe' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status' }, rueckweg: { keiner: 'Probe-Snapshot, nichts zu bewahren' } },
    { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'ping', ziel: '192.168.1.240' } },
  ],
});

describe('I3 Einordnung der Aktionen', () => {
  it('lesen, Sicherung, ändern, löschen; Fernzugriff nach Befehlsklasse', () => {
    expect(aktionsArt('proxmox', 'list_vms')).toBe('lesen');
    expect(aktionsArt('proxmox', 'create_snapshot')).toBe('sicherung');
    expect(aktionsArt('proxmox', 'clone_vm')).toBe('aendern');
    expect(aktionsArt('proxmox', 'delete_vm')).toBe('loeschen');
    expect(aktionsArt('proxmox', 'delete_backup')).toBe('loeschen');
    expect(aktionsArt('proxmox', 'delete_backup_job')).toBe('aendern'); // Rückweg des Übergangsjobs, kein Löschen von Daten
    expect(aktionsArt('proxmox', 'list_backup_jobs')).toBe('lesen');
    expect(aktionsArt('unifi', 'set_fixed_ip')).toBe('aendern');
    expect(aktionsArt('nginx_proxy_manager', 'update_host')).toBe('aendern');
    expect(aktionsArt('fernzugriff', 'ausfuehren', { befehl: 'uptime' })).toBe('lesen');
    expect(aktionsArt('fernzugriff', 'ausfuehren', { befehl: 'systemctl restart nginx' })).toBe('aendern');
    expect(aktionsArt('fernzugriff', 'pruefen')).toBe('lesen'); // v1628
    expect(aktionsArt('fernzugriff', 'liste')).toBe('lesen');
    expect(aktionsArt('fernzugriff', 'entfernen')).toBe('aendern');
  });
});

describe('I3 Prüfung beim Anlegen', () => {
  it('gültiger Snapshot-Probe-Change: keine Fehler, Pläne aus den Schritten', () => {
    const p = pruefeChangePlan(snapshotChange(), ctx());
    expect(p.fehler).toEqual([]);
    expect(p.betroffeneIds).toEqual(['a-test']);
    expect(p.plan.schritte.map(s => s.einordnung)).toEqual(['lesen', 'sicherung', 'aendern', undefined]);
    const pl = plaeneAusSchritten(p.plan);
    expect(pl.umsetzung).toContain('2. Snapshot anlegen — proxmox.create_snapshot (vmid=9001, name=i3probe) [sicherung]');
    expect(pl.rueckweg).toContain('zu Schritt 3 (Snapshot löschen): kein Rückweg — Probe-Snapshot');
    expect(pl.test).toContain('Schritt 4: Ping 192.168.1.240');
  });
  it('weist ab: unbekannte Aktion/Skill, Nie-Skill, fehlender Rückweg, keine Sicherung vor Änderung, Löschen ohne Stilllegung, Platzhalter, falsche Verweise, Nie-Befehl, mehrdeutiges Asset', () => {
    const f = pruefeChangePlan({
      titel: 'Alles falsch', begruendung: 'zeigt die Regeln', typ: 'standard', risiko: 'hoch', betroffen: ['dockerhost', 'gibtsnicht'],
      schritte: [
        { titel: 'VM klonen', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', parameter: { name: 'neu' }, pruefung: { typ: 'port', ziel: '10.0.0.5', port: 22 } },
        { titel: 'VLAN anlegen', art: 'aktion', skill: 'unifi', aktion: 'create_network' },
        { titel: 'Netz', art: 'aktion', skill: 'proxmox', aktion: 'create_vlan' },
        { titel: 'Selbst freigeben', art: 'aktion', skill: 'itsm', aktion: 'approve_change' },
        { titel: 'Alte VM weg', art: 'aktion', skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 120 }, pruefung: { typ: 'ping', ziel: 'x' }, rueckweg: { keiner: 'geht nicht' } },
        { titel: 'Proxy', art: 'aktion', skill: 'nginx_proxy_manager', aktion: 'update_host', parameter: { forward_host: '{{schritt9.ip}}', id: '<host-id>' }, pruefung: { typ: 'http', ziel: 'https://x.at' }, rueckweg: { skill: 'nginx_proxy_manager', aktion: 'update_host' } },
        { titel: 'Platte', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'dockerhost', befehl: 'mkfs.ext4 /dev/sda' }, pruefung: { typ: 'befehl', zugang: 'dockerhost', befehl: 'rm -rf /tmp/x' }, rueckweg: { keiner: 'x' } },
        { titel: '', art: 'warten' },
      ],
    }, ctx()).fehler.join('\n');
    for (const t of ['Standard-Changes', 'ausfallMinuten fehlt', '„dockerhost“ ist mehrdeutig', '„gibtsnicht“ ist kein CMDB-Asset', 'Schritt 1: rueckweg fehlt', 'Skill „unifi“ gibt es nicht', 'proxmox kennt die Aktion „create_vlan“ nicht', 'als owner-Schritt planen', 'Skill itsm ist in Changes nicht erlaubt', 'entfernt Bestehendes endgültig', 'Verweis {{schritt9.ip}} zeigt nicht auf eine frühere Aktion', 'Platzhalter', 'Nie-Liste', 'kein reiner Lesebefehl', 'Schritt 8: titel fehlt', 'warten braucht sekunden oder eine pruefung', 'Vor der ersten ändernden Aktion (Schritt 1) fehlt eine Sicherung'])
      expect(f).toContain(t);
  });
  it('ohneSicherungGrund erlaubt reine Neuanlage; Verweis auf frühere Aktion ist gültig; Owner-Schritt für fehlende Fähigkeiten', () => {
    const p = pruefeChangePlan({
      titel: 'Neue VM matrix', begruendung: 'Zielarchitektur Gruppe Kommunikation', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['pve'], ohneSicherungGrund: 'legt nur eine neue VM an',
      schritte: [
        { titel: 'Klonen', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', parameter: { name: 'matrix' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'matrix' }, rueckweg: { skill: 'proxmox', aktion: 'stop_vm', parameter: { vmid: '{{schritt1.vmid}}' } } },
        { titel: 'Starten', art: 'aktion', skill: 'proxmox', aktion: 'start_vm', parameter: { vmid: '{{schritt1.vmid}}' }, pruefung: { typ: 'ping', ziel: '{{schritt1.ip}}' }, rueckweg: { skill: 'proxmox', aktion: 'stop_vm', parameter: { vmid: '{{schritt1.vmid}}' } } },
        { titel: 'VLAN 821 in UniFi anlegen', art: 'owner', frage: 'Bitte VLAN 821 in UniFi anlegen und bestätigen' },
        { titel: 'Warten bis SSH', art: 'warten', pruefung: { typ: 'port', ziel: '{{schritt1.ip}}', port: 22 }, zeitlimitS: 300 },
      ],
    }, ctx());
    expect(p.fehler).toEqual([]);
    expect(p.hinweise.join('\n')).toContain('Ohne Sicherung geplant');
    expect(p.hinweise.join('\n')).toContain('Owner-Schritte');
  });
  it('Fingerabdruck: gleich bei gleicher Struktur (Schlüsselreihenfolge egal), anders bei jeder Parameteränderung', () => {
    const a = pruefeChangePlan(snapshotChange(), ctx());
    const umgestellt = snapshotChange(); umgestellt.schritte[1]!.parameter = { name: 'i3probe', vmid: 9001 };
    const b = pruefeChangePlan(umgestellt, ctx());
    expect(changeFingerabdruck(a.plan, a.betroffeneIds, [])).toBe(changeFingerabdruck(b.plan, b.betroffeneIds, []));
    const geaendert = snapshotChange(); geaendert.schritte[1]!.parameter = { vmid: 9002, name: 'i3probe' };
    const c = pruefeChangePlan(geaendert, ctx());
    expect(changeFingerabdruck(c.plan, c.betroffeneIds, [])).not.toBe(changeFingerabdruck(a.plan, a.betroffeneIds, []));
    expect(changeFingerabdruck(a.plan, a.betroffeneIds, ['x'])).not.toBe(changeFingerabdruck(a.plan, a.betroffeneIds, []));
  });
  it('Zyklen', () => {
    expect(zyklus(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toBeUndefined();
    expect(zyklus(new Map([['a', ['b']], ['b', ['a']]]))).toEqual(['a', 'b', 'a']);
  });
});

/** In-Memory-ITSM mit denselben Regeln wie das Repository (Freigabe nur bei passendem Fingerabdruck). */
function speicher() {
  const db = new Map<string, CmdbChangeRequest>(); let n = 0;
  const aus = (d: ChangeSchrittDaten, id: string, alt?: CmdbChangeRequest): CmdbChangeRequest => ({
    id, userId: 'o', title: d.title, description: d.description, type: d.type, status: alt?.status ?? 'submitted', riskLevel: d.riskLevel,
    affectedAssetIds: d.affectedAssetIds, affectedServiceIds: [], implementationPlan: d.implementationPlan, rollbackPlan: d.rollbackPlan, testPlan: d.testPlan,
    ...(d.scheduledAt ? { scheduledAt: d.scheduledAt } : {}), schritte: d.schritte, abhaengigVon: d.abhaengigVon, ausfallMinuten: d.ausfallMinuten, pruefung: d.pruefung, fingerabdruck: d.fingerabdruck,
    ...(d.vorhabenId ? { vorhabenId: d.vorhabenId } : {}), createdAt: 'x', updatedAt: 'x',
  });
  return {
    db,
    liste: async () => [...db.values()],
    hole: async (_o: string, id: string) => db.get(id) ?? null,
    legeAn: async (_o: string, d: ChangeSchrittDaten) => { const id = `chg-${String(++n).padStart(4, '0')}-0000`; db.set(id, aus(d, id)); return db.get(id)!; },
    setzeSchritte: async (_o: string, id: string, d: ChangeSchrittDaten) => { const e = db.get(id)!; const bleibt = e.status === 'approved' && e.freigabeFingerabdruck === d.fingerabdruck; const neu = aus(d, id, e); neu.status = bleibt ? 'approved' : 'submitted'; if (bleibt) neu.freigabeFingerabdruck = e.freigabeFingerabdruck; db.set(id, neu); return neu; },
    freigeben: async (_o: string, id: string, fp: string, ueber: 'frage' | 'web') => { const e = db.get(id)!; if (e.status !== 'submitted' || e.fingerabdruck !== fp) throw new Error('Freigabe ungültig'); Object.assign(e, { status: 'approved', freigabeFingerabdruck: fp, freigegebenUeber: ueber }); return e; },
    setzeFreigabeAnfrage: async (_o: string, id: string, a: CmdbChangeRequest['freigabeAnfrage'] | null) => { const e = db.get(id)!; if (a) e.freigabeAnfrage = a; else delete e.freigabeAnfrage; },
  };
}
describe('v1644 angehaltenen Change ohne Wirkung neu planen (Realfall 5d960660)', () => {
  it('Halt nach Prüfung/fehlgeschlagenem Schritt ohne Daten → änderbar, Lauf weg, neue Freigabe; nach Wirkung → abgewiesen', async () => {
    const it3 = speicher();
    let haltFlag: boolean | undefined; let korrekturAb: number | undefined;
    const orig = it3.setzeSchritte;
    it3.setzeSchritte = async (o: string, id: string, d: ChangeSchrittDaten, x?: { haltOhneWirkung?: boolean; korrekturAb?: number }) => { haltFlag = x?.haltOhneWirkung; korrekturAb = x?.korrekturAb; const r = await orig(o, id, d); delete (r as { lauf?: unknown }).lauf; return r; };
    const pl = new ChangePlanung({ itsm: it3 as never, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: keineAuswirkung });
    const ok = await pl.planen('o', [snapshotChange()]);
    if (!ok.ok) throw new Error('planen');
    const c = it3.db.get(ok.changes[0]!.id)!;
    Object.assign(c, { status: 'in_progress', lauf: { phase: 'angehalten', schritt: 2, ergebnisse: [{ nr: 1, ok: true }, { nr: 2, ok: false }] } });
    const r = await pl.aendern('o', c.id, snapshotChange());
    expect(r.ok).toBe(true);
    expect(haltFlag).toBe(true);
    if (r.ok) expect(r.freigabeVerfallen).toBe(true);
    const d = it3.db.get(c.id)!;
    Object.assign(d, { status: 'in_progress', lauf: { phase: 'angehalten', schritt: 3, ergebnisse: [{ nr: 3, ok: false, aktionOk: true }] } }); // Schritt 3 (aendern) hat gewirkt
    // v1661 — Realfall 0cd5c0a4: mit Wirkung ab dem Haltepunkt korrigierbar; gelaufene Schritte übernimmt der Server unverändert
    const geaendert = snapshotChange();
    geaendert.schritte[0]!.titel = 'Zustand lesen (vom Modell umformuliert)';
    (geaendert.schritte[2]!.rueckweg as { keiner: string }).keiner = 'Probe-Snapshot, korrigierter Grund';
    const r2 = await pl.aendern('o', d.id, geaendert);
    expect(r2.ok).toBe(true);
    expect(korrekturAb).toBe(3);
    const e = it3.db.get(d.id)!;
    expect((e.schritte as ChangeSchritt[])[0]!.titel).toBe('Zustand lesen');
    expect((e.schritte as ChangeSchritt[])[2]!.rueckweg).toEqual({ keiner: 'Probe-Snapshot, korrigierter Grund' });
    if (r2.ok) expect(r2.freigabeVerfallen).toBe(true);
    const kurz = snapshotChange(); kurz.schritte = kurz.schritte.slice(0, 2);
    Object.assign(it3.db.get(d.id)!, { status: 'in_progress', lauf: { phase: 'angehalten', schritt: 3, ergebnisse: [{ nr: 3, ok: false, aktionOk: true }] } });
    const r3 = await pl.aendern('o', d.id, kurz);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.fehler.join(' ')).toContain('nur ab Schritt 3 änderbar');
    Object.assign(it3.db.get(d.id)!, { status: 'in_progress', lauf: { phase: 'laeuft', schritt: 3, ergebnisse: [] } });
    const r4 = await pl.aendern('o', d.id, snapshotChange());
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.fehler.join(' ')).toContain('läuft gerade');
  });
});

const keineAuswirkung = async (ids: string[]) => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] });

describe('I3 Paket planen und Owner-Freigabe', () => {
  it('Paket: alles oder nichts, Abhängigkeiten in Reihenfolge, Zyklen abgewiesen', async () => {
    const it3 = speicher();
    const pl = new ChangePlanung({ itsm: it3, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: keineAuswirkung });
    const kaputt = await pl.planen('o', [{ ...snapshotChange(), schluessel: 'a' }, { titel: 'x' }]);
    expect(kaputt.ok).toBe(false);
    expect(it3.db.size).toBe(0);
    const kreis = await pl.planen('o', [{ ...snapshotChange(), schluessel: 'a', abhaengigVon: ['b'] }, { ...snapshotChange(), schluessel: 'b', abhaengigVon: ['a'] }]);
    expect(kreis.ok).toBe(false);
    if (!kreis.ok) expect(kreis.fehler.join('\n')).toContain('Abhängigkeiten im Kreis');
    const ok = await pl.planen('o', [{ ...snapshotChange(), schluessel: 'spaeter', abhaengigVon: ['zuerst'] }, { ...snapshotChange(), schluessel: 'zuerst' }]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const [erst, dann] = ok.changes;
    expect(dann!.abhaengigVon).toEqual([erst!.id]);
    expect(await pl.planen('o', [snapshotChange()], { id: 'v1', status: 'architektur_vorgeschlagen', titel: 'V' })).toMatchObject({ ok: false });
  });

  it('Freigabe nur über das Ja auf die Frage: Hash am Change, einmal verwendbar, an den Plan gebunden; Planänderung → neue Freigabe', async () => {
    const it3 = speicher();
    let frage: { description: string; params: Record<string, unknown> } | undefined;
    let jetzt = Date.parse('2026-10-22T10:00:00Z');
    const pl = new ChangePlanung({ itsm: it3, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: keineAuswirkung, bestaetigung: async f => { frage = f; return true; }, jetzt: () => jetzt });
    const r = await pl.planen('o', [snapshotChange()]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const id = r.changes[0]!.id;
    // ohne Frage keine Freigabe (Modell ruft freigeben selbst)
    expect((await pl.freigebenNachJa('o', { changes: [{ id, fingerabdruck: r.changes[0]!.fingerabdruck }], freigabe: 'erfunden' })).ok).toBe(false);
    expect((await pl.freigabeAnfragen('o', [id.slice(0, 8)])).ok).toBe(true);
    expect(frage!.description).toContain('Snapshot-Probe test-vm');
    expect(frage!.description).toContain('Freigabe gilt genau für Plan');
    expect(it3.db.get(id)!.freigabeAnfrage!.hash).not.toBe(frage!.params.freigabe); // nur der Hash steht am Change
    // falscher Wert → nein; richtiger → ja; zweites Mal → nein
    expect((await pl.freigebenNachJa('o', { ...frage!.params, freigabe: 'falsch' })).ok).toBe(false);
    const ja = await pl.freigebenNachJa('o', frage!.params);
    expect(ja).toMatchObject({ ok: true });
    expect(it3.db.get(id)!.status).toBe('approved');
    expect((await pl.freigebenNachJa('o', frage!.params)).ok).toBe(false);
    // gleiche Struktur erneut speichern → Freigabe bleibt; geänderter Parameter → verfällt
    expect((await pl.aendern('o', id, planAusChange(it3.db.get(id)!)))).toMatchObject({ ok: true, freigabeVerfallen: false });
    const neu = snapshotChange(); neu.schritte[1]!.parameter = { vmid: 9001, name: 'anders' };
    expect(await pl.aendern('o', id, neu)).toMatchObject({ ok: true, freigabeVerfallen: true });
    expect(it3.db.get(id)!.status).toBe('submitted');
    // abgelaufene Frage
    await pl.freigabeAnfragen('o', [id]);
    jetzt += FREIGABE_FRAGE_GUELTIG_MS + 1000;
    expect((await pl.freigebenNachJa('o', frage!.params)).ok).toBe(false);
    // Frage gestellt, danach Plan geändert → altes Ja ungültig
    jetzt = Date.parse('2026-10-22T11:00:00Z');
    await pl.freigabeAnfragen('o', [id]);
    const alteFrage = frage!;
    const nochmal = snapshotChange(); nochmal.schritte[1]!.parameter = { vmid: 9001, name: 'drittens' };
    await pl.aendern('o', id, nochmal);
    expect((await pl.freigebenNachJa('o', alteFrage.params)).ok).toBe(false);
  });

  it('Web-Freigabe prüft erneut; offener kritischer Incident blockiert Normal-Changes', async () => {
    const it3 = speicher();
    let incidents: string[] = [];
    const pl = new ChangePlanung({ itsm: it3, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: async ids => ({ ...(await keineAuswirkung(ids)), offeneIncidents: incidents }) });
    const r = await pl.planen('o', [snapshotChange()]);
    if (!r.ok) throw new Error('x');
    incidents = ['Platte voll (critical)'];
    await expect(pl.freigebenWeb('o', r.changes[0]!.id)).rejects.toThrow('Offener kritischer Incident');
    incidents = [];
    expect((await pl.freigebenWeb('o', r.changes[0]!.id)).freigegebenUeber).toBe('web');
  });
});

describe('I3 Asset-Auflösung (Realfall 22.10.: test-ubuntu als Deploy-Anwendung und VM)', () => {
  it('sourceId und ID-Anfang lösen auf; mehrdeutig nennt volle IDs mit Typ und Quelle', async () => {
    const it3 = speicher();
    const liste = [
      { id: 'cadab99c-0e34-4d48-bc0a-0adafcb31a96', name: 'test-ubuntu', status: 'active', assetType: 'application', sourceSkill: 'deploy', sourceId: 'deploy:192.168.1.96:test-ubuntu' },
      { id: 'f278eb95-3463-481a-9d06-497b2c5fecdf', name: 'test-ubuntu', status: 'active', assetType: 'vm', sourceSkill: 'proxmox', sourceId: 'pve3:142' },
      { id: '38cc7619-e59b-4a51-aa92-978685f142e3', name: 'test-ubuntu', status: 'unknown', assetType: 'vm', sourceSkill: 'proxmox', sourceId: 'pve:142' },
    ];
    const pl = new ChangePlanung({ itsm: it3, skill: n => SKILLS[n] as never, assets: async () => liste, auswirkung: keineAuswirkung });
    const mehr = await pl.planen('o', [{ ...snapshotChange(), betroffen: ['test-ubuntu'] }]);
    expect(mehr.ok).toBe(false);
    if (!mehr.ok) { expect(mehr.fehler.join('\n')).toContain('f278eb95-3463-481a-9d06-497b2c5fecdf (vm, proxmox pve3:142)'); expect(mehr.fehler.join('\n')).not.toContain('38cc7619'); }
    const r1 = await pl.planen('o', [{ ...snapshotChange(), betroffen: ['pve3:142'] }]);
    expect(r1.ok && r1.changes[0]!.affectedAssetIds).toEqual(['f278eb95-3463-481a-9d06-497b2c5fecdf']);
    const r2 = await pl.planen('o', [{ ...snapshotChange(), betroffen: ['f278eb95'] }]);
    expect(r2.ok && r2.changes[0]!.affectedAssetIds).toEqual(['f278eb95-3463-481a-9d06-497b2c5fecdf']);
  });
});

describe('I3 Negative Prüfung (Realfall 22.10.: „abbrechen, wenn i3probe schon existiert“)', () => {
  it('nichtEnthalten bei skill/befehl/http, sonst Fehler; im Plan lesbar', () => {
    const c = snapshotChange();
    c.schritte[0] = { titel: 'Snapshot darf noch nicht existieren', art: 'pruefung', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', nichtEnthalten: 'i3probe' } } as never;
    const p = pruefeChangePlan(c, ctx());
    expect(p.fehler).toEqual([]);
    expect(plaeneAusSchritten(p.plan).umsetzung).toContain('→ enthält nicht „i3probe“');
    c.schritte[0] = { titel: 'x', art: 'pruefung', pruefung: { typ: 'ping', ziel: 'a', nichtEnthalten: 'b' } } as never;
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).toContain('nichtEnthalten gibt es nur bei');
    // v1675 — Realfall 26.10. 5b7dc0f9: nichtEnthalten steckt im erwarteten Text → nie erfüllbar
    c.schritte[0] = { titel: 'x', art: 'pruefung', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'lvmthin: data2-pve3', nichtEnthalten: 'lvmthin: data2' } } as never;
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).toContain('kann nie bestehen');
    c.schritte[0] = { titel: 'x', art: 'pruefung', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'data2-pve3', nichtEnthalten: 'data2:' } } as never;
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).not.toContain('kann nie bestehen');
  });
});

describe('I4 Realfall: unerfüllbare Prüfung im Plan', () => {
  it('erwartet mit Verneinung wird abgewiesen, Textstück bleibt erlaubt', () => {
    const c = snapshotChange();
    (c.schritte[1] as { pruefung: Record<string, unknown> }).pruefung = { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'Snapshot i3probe ist nicht vorhanden' };
    expect(pruefeChangePlan(c, ctx()).fehler.join(' ')).toContain('nichtEnthalten mit dem Namen verwenden');
    (c.schritte[1] as { pruefung: Record<string, unknown> }).pruefung = { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'i3probe' };
    expect(pruefeChangePlan(c, ctx()).fehler).toEqual([]);
  });
});

// I6 — Geheimnis im selben Change übernehmen und am Ziel schreiben; Kopieren ohne Rückweg zulässig
describe('I6 Migration im Plan', () => {
  const plan = (mitUebernahme: boolean) => ({
    titel: 'Dashy umziehen', begruendung: 'Probe-Migration', typ: 'normal', risiko: 'niedrig', betroffen: ['dockerhost'], ohneSicherungGrund: 'Quelle bleibt unberührt',
    schritte: [
      ...(mitUebernahme ? [{ titel: '.env in den Tresor', art: 'aktion', skill: 'fernzugriff', aktion: 'geheim_uebernehmen', parameter: { name: 'dockerhost', pfad: '/opt/dashy/.env', tresor_name: 'dashy-env' }, rueckweg: { keiner: 'nur Tresor' } }] : []),
      { titel: 'Daten vorkopieren', art: 'aktion', skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'dockerhost', quelle_pfad: '/opt/dashy', ziel: 'web1', ziel_pfad: '/srv/dashy' }, pruefung: { typ: 'datei', zugang: 'web1', pfad: '/srv/dashy' }, rueckweg: { keiner: 'Quelle bleibt unberührt' } },
      { titel: '.env schreiben', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'web1', befehl: 'install -m 600 {{geheimdatei:dashy-env}} /srv/dashy/.env' }, pruefung: { typ: 'datei', zugang: 'web1', pfad: '/srv/dashy/.env' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'web1', befehl: 'rm -f /srv/dashy/.env' } } },
    ],
  });
  it('Tresor-Name aus geheim_uebernehmen gilt für spätere Schritte; ohne die Übernahme fehlt er', () => {
    const k = { ...ctx(), tresorNamen: new Set<string>() };
    const ok = pruefeChangePlan(plan(true), k);
    expect(ok.fehler.filter(x => /Tresor|Rückweg|rueckweg/.test(x))).toEqual([]);
    expect(pruefeChangePlan(plan(false), k).fehler.some(x => x.includes('Tresor-Eintrag „dashy-env“ gibt es nicht'))).toBe(true);
  });
});

describe('v1610 Kopierpfade schon beim Planen prüfen (Realfall dea4b9cd)', () => {
  it('quelle_pfad unter /root und ziel_pfad außerhalb der Zielbereiche werden abgewiesen, /srv geht', () => {
    const plan = (quelle: string, ziel: string) => ({ titel: 'Image übertragen', begruendung: 'Probe', typ: 'normal', risiko: 'niedrig', betroffen: ['dockerhost'], ohneSicherungGrund: 'Quelle bleibt',
      schritte: [{ titel: 'Archiv kopieren', art: 'aktion', skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'dockerhost', quelle_pfad: quelle, ziel: 'web1', ziel_pfad: ziel }, rueckweg: { keiner: 'Quelle bleibt' } }] });
    const f1 = pruefeChangePlan(plan('/root/wp-lk-dev-images', '/srv/wp-lk-dev-images'), ctx()).fehler;
    expect(f1.some(x => x.includes('quelle_pfad /root/wp-lk-dev-images: Systembereich'))).toBe(true);
    expect(pruefeChangePlan(plan('/srv/wp-export', '/etc/x'), ctx()).fehler.some(x => x.includes('ziel_pfad /etc/x'))).toBe(true);
    expect(pruefeChangePlan(plan('/srv/wp-export', '/srv/wp-lk-dev-images'), ctx()).fehler.filter(x => x.includes('_pfad'))).toEqual([]);
  });
});

describe('v1622 Stilllegung: Entfernen per Fernzugriff ohne Rückweg (Realfall Restwirkung b85e56af)', () => {
  const plan = (zweck?: string) => ({ titel: 'Hilfsarchiv entfernen', begruendung: 'Restwirkung eines abgebrochenen Changes', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['test-vm'], ohneSicherungGrund: 'reines Hilfsarchiv', ...(zweck ? { zweck } : {}),
    schritte: [
      { titel: 'Vorhanden?', art: 'aktion', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: 'dockerhost', befehl: 'ls -la /srv/wp-lk-dev-export' } },
      { titel: 'Entfernen', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'dockerhost', befehl: 'rm -rf -- /srv/wp-lk-dev-export' }, pruefung: { typ: 'skill', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: 'dockerhost', befehl: 'ls /srv' }, nichtEnthalten: 'wp-lk-dev-export' }, rueckweg: { keiner: 'Hilfsarchiv eines abgebrochenen Changes' } },
    ] });
  it('mit zweck stilllegung zulässig, sonst Rückweg nötig', () => {
    expect(pruefeChangePlan(plan('stilllegung'), ctx()).fehler).toEqual([]);
    expect(pruefeChangePlan(plan(), ctx()).fehler.join(' | ')).toContain('ohne Rückweg nur bei');
  });
});

describe('I6 Planprüfung: Go-Templates und selbstprüfende Aktionen', () => {
  it('docker --format mit range/println/end ist kein Platzhalter; kopieren ohne eigene Prüfung zulässig', () => {
    const plan = {
      titel: 'Env exportieren', begruendung: 'Pilot: Umgebung exportieren und Daten kopieren', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['test-vm'], ohneSicherungGrund: 'Quelle bleibt',
      schritte: [
        { titel: 'Env exportieren', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'dockerhost', befehl: "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' pgadmin4-pgadmin-1 > /root/x.env" }, pruefung: { typ: 'datei', zugang: 'dockerhost', pfad: '/root/x.env' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'dockerhost', befehl: 'rm -f /root/x.env' } } },
        { titel: 'Kopieren', art: 'aktion', skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'dockerhost', quelle_pfad: '/opt/a', ziel: 'web1', ziel_pfad: '/srv/a' }, rueckweg: { keiner: 'Quelle bleibt' } },
      ],
    };
    const r = pruefeChangePlan(plan, ctx());
    expect(r.fehler).toEqual([]);
    const ohne = pruefeChangePlan({ ...plan, schritte: [{ ...plan.schritte[0], pruefung: undefined }] }, ctx());
    expect(ohne.fehler.some(x => x.includes('pruefung fehlt'))).toBe(true); // nur selbstprüfende Aktionen sind ausgenommen
    expect(pruefeChangePlan({ ...plan, schritte: [{ ...plan.schritte[0], parameter: { name: 'dockerhost', befehl: 'echo {{host_id}}' } }] }, ctx()).fehler.some(x => x.includes('Platzhalter'))).toBe(true);
  });
});

describe('v1636 Datenbank-Inventar als Vorher/Nachher-Nachweis', () => {
  it('datenbank_inventar ist lesend und als Prüfung mit Verweis auf den Vorher-Fingerabdruck zulässig', () => {
    SKILLS.fernzugriff = skill('fernzugriff', ['lesen', 'ausfuehren', 'kopieren', 'geheim_uebernehmen', 'pruefen', 'datenbank_inventar'], { name: { type: 'string' }, befehl: { type: 'string' }, container: { type: 'string' }, art: { type: 'string' } });
    expect(aktionsArt('fernzugriff', 'datenbank_inventar')).toBe('lesen');
    const p = pruefeChangePlan({ titel: 'Inventar-Probe', begruendung: 'Datenbestand vor und nach dem Umzug nachweisen', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['test-vm'],
      schritte: [
        { titel: 'Vorher', art: 'aktion', skill: 'fernzugriff', aktion: 'datenbank_inventar', parameter: { name: 'dockerhost', container: 'postgreDEV', art: 'postgres' } },
        { titel: 'Nachher gleich', art: 'pruefung', pruefung: { typ: 'skill', skill: 'fernzugriff', aktion: 'datenbank_inventar', parameter: { name: 'docker-dev-01', container: 'postgreDEV', art: 'postgres' }, erwartet: '{{schritt1.fingerabdruck}}' } },
      ] }, ctx());
    expect(p.fehler).toEqual([]);
  });
});

describe('v1664 nach einem Dienst-Stopp nur mit Rückweg (Realfall cb3fd65c)', () => {
  const plan = (nachStopp: 'anhalten' | 'rueckweg') => ({
    titel: 'Backend reparieren', begruendung: 'Probe', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 15, betroffen: ['test-vm'],
    schritte: [
      { titel: 'Sichern', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9001, name: 'vor' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', erwartet: 'vor' } },
      { titel: 'Backend stoppen', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', beiFehler: 'rueckweg', parameter: { name: 'test-vm', befehl: 'docker stop -t 60 backend' }, pruefung: { typ: 'ping', ziel: '192.168.1.240' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'test-vm', befehl: 'docker start backend' } } },
      { titel: 'Reparieren', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', beiFehler: nachStopp, parameter: { name: 'test-vm', befehl: 'touch /srv/x' }, pruefung: { typ: 'ping', ziel: '192.168.1.240' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'test-vm', befehl: 'rm -f /srv/x' } } },
      { titel: 'Backend starten', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', beiFehler: 'rueckweg', parameter: { name: 'test-vm', befehl: 'docker start backend' }, pruefung: { typ: 'ping', ziel: '192.168.1.240' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'test-vm', befehl: 'docker stop backend' } } },
      { titel: 'Abschluss', art: 'pruefung', beiFehler: 'anhalten', pruefung: { typ: 'ping', ziel: '192.168.1.240' } },
    ],
  });
  it('„anhalten“ nach dem Stopp wird abgewiesen, nach dem Wiederstart wieder erlaubt', () => {
    const schlecht = pruefeChangePlan(plan('anhalten'), ctx());
    expect(schlecht.fehler.join('\n')).toContain('Schritt 3: nach dem Dienst-Stopp in Schritt 2 muss beiFehler „rueckweg“ sein');
    const gut = pruefeChangePlan(plan('rueckweg'), ctx());
    expect(gut.fehler.filter(x => x.includes('Dienst-Stopp'))).toEqual([]); // Schritt 5 (nach dem Start) darf anhalten
  });
});

// v1673 — Realfall 25.10. pgsql-p01: Prüfbefehle wie zur Laufzeit (Leseliste, Metadaten oder Lese-Käfig), verändernde bleiben abgewiesen
describe('v1673 Prüfbefehle im Lese-Käfig', () => {
  it('lesende Befehle außerhalb der Leseliste sind zulässig, verändernde, mehrzeilige und Geheimnisse nicht', async () => {
    const { pruefbefehlFehler } = await import('./change-schritte.js');
    for (const ok of ['ls -l /etc/postgresql/17/main/pg_hba.conf.vor-peer-20261025', 'head -n 1 /etc/postgresql/17/main/pg_hba.conf',
      "ps -eo pid,args | grep 'postgres: 17/main: synapse'", 'cmp /etc/postgresql/17/main/pg_hba.conf /etc/postgresql/17/main/pg_hba.conf.vor-peer',
      "grep -c '^local' /etc/postgresql/17/main/pg_hba.conf", 'systemctl is-active postgresql@17-main', 'zpool status', 'ls -la /opt/app/.env']) {
      expect(pruefbefehlFehler(ok), ok).toBeUndefined();
    }
    for (const nein of ['rm -rf /tmp/x', 'mkfs.ext4 /dev/sda', 'cat /opt/app/.env', 'echo x > /etc/y', 'systemctl restart postgresql', 'docker restart synapse',
      "sed -i 's/a/b/' /etc/x", 'ls /tmp\ncat /etc/shadow', 'cat /etc/x | tee /etc/y', 'sudo -n rm /x']) {
      expect(pruefbefehlFehler(nein), nein).toBeDefined();
    }
  });
});

// v1676 — Realfall 26.10. Matrix E: image_holen mit @{{schrittN.digest}} und gitlab.registry als Prüfung
describe('v1676 Verweise im Teil eines Werts, GitLab lesend', () => {
  it('image_holen mit …@{{schritt1.digest}} besteht die Eingabeprüfung; gitlab ist lesend', async () => {
    const { FernzugriffSkill } = await import('../fernzugriff/fernzugriff-skill.js');
    const fz = Object.create(FernzugriffSkill.prototype) as { pruefeEingabe: (i: Record<string, unknown>) => string | undefined; metadata: unknown };
    const echt = skill('fernzugriff', ['image_hochladen', 'image_holen'], { name: { type: 'string' }, image: { type: 'string' }, registry_ziel: { type: 'string' } }, i => fz.pruefeEingabe(i));
    const c = {
      titel: 'Image übertragen', begruendung: 'Originalimage in die eigene Registry und am Ziel holen', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['test-vm'],
      schritte: [
        { titel: 'Hochladen', art: 'aktion', skill: 'fernzugriff', aktion: 'image_hochladen', parameter: { name: 'dockerhost-a', image: 'sha256:' + 'a'.repeat(64), registry_ziel: 'registry.lokalkraft.at/madh/alfred-ai/matrix-sydent:migration-20261026' }, pruefung: { typ: 'skill', skill: 'gitlab', aktion: 'registry', erwartet: '{{schritt1.digest}}' }, rueckweg: { keiner: 'nur Kopie' } },
        { titel: 'Holen', art: 'aktion', skill: 'fernzugriff', aktion: 'image_holen', parameter: { name: 'docker-com-01', image: 'registry.lokalkraft.at/madh/alfred-ai/matrix-sydent@{{schritt1.digest}}' }, rueckweg: { keiner: 'nur Image' } },
      ],
    };
    const k = { ...ctx(), skill: (n: string) => (n === 'fernzugriff' ? echt : n === 'gitlab' ? skill('gitlab', ['projekte', 'registry']) : SKILLS[n]) as never };
    const fehler = pruefeChangePlan(c, k).fehler.join('\n');
    expect(fehler).not.toContain('image_holen braucht');
    expect(fehler).not.toContain('gitlab.registry ist nicht lesend');
    expect(aktionsArt('gitlab', 'registry')).toBe('lesen');
  });
});

// v1677 — Realfall 26.10. Matrix I: Rückweg fernzugriff.kopieren (ohne Befehl) galt als Nie-Liste
describe('v1677 Rückweg kopieren', () => {
  it('kopieren als Rückweg ist erlaubt, ein Nie-Befehl im Rückweg weiter nicht', () => {
    const c = {
      titel: 'Daten kopieren', begruendung: 'Kaltkopie mit Rückkopie als Rückweg', typ: 'normal', risiko: 'mittel', ausfallMinuten: 30, betroffen: ['test-vm'],
      schritte: [
        { titel: 'Snapshot', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9001, name: 'vor' }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 9001, name: 'vor' } } },
        { titel: 'Kopie', art: 'aktion', skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'a', quelle_pfad: '/x', ziel: 'b', ziel_pfad: '/y' }, rueckweg: { skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'b', quelle_pfad: '/y', ziel: 'a', ziel_pfad: '/srv/zurueck' } } },
      ],
    };
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).not.toContain('Nie-Liste');
    (c.schritte[1] as { rueckweg: unknown }).rueckweg = { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'a', befehl: 'mkfs.ext4 /dev/sdb' } };
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).toContain('Nie-Liste');
  });
});

// v1678 — Review 26.10. Matrix: Netzproben im Käfig, Rückweg auf den Originalpfad
describe('v1678 Käfig-Netzproben und Rückweg aufs Original', () => {
  it('Netzprobe per python/curl/systemctl is-enabled abgewiesen, Leseliste erlaubt', async () => {
    const { pruefbefehlFehler } = await import('./change-schritte.js');
    expect(pruefbefehlFehler(`python3 -c 'import socket; socket.create_connection(("192.168.1.211",3000),5)'`)).toMatch(/ohne Netz/);
    expect(pruefbefehlFehler('systemctl is-enabled certbot.timer')).toMatch(/D-Bus/);
    expect(pruefbefehlFehler('curl -s https://chat.3033.at/_matrix/client/versions')).toMatch(/ohne Netz/);
    expect(pruefbefehlFehler('nc -z -w 5 192.168.1.211 3000')).toBeUndefined();
    expect(pruefbefehlFehler('systemctl is-active certbot.timer')).toBeUndefined();
    expect(pruefbefehlFehler('head -n 1 /etc/hosts')).toBeUndefined();
  });
  it('Rückweg kopieren mit loeschen auf den Originalpfad wird abgewiesen, Staging erlaubt', () => {
    const mk = (rueckZiel: string, loeschen: boolean) => ({
      titel: 'Kaltkopie', begruendung: 'Kaltkopie der Daten mit Rückweg', typ: 'normal', risiko: 'mittel', ausfallMinuten: 30, betroffen: ['test-vm'],
      schritte: [
        { titel: 'Snapshot', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9001, name: 'vor' }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 9001, name: 'vor' } } },
        { titel: 'Kopie', art: 'aktion', skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'dockerhost', quelle_pfad: '/home/synapse/data', ziel: 'neu', ziel_pfad: '/srv/matrix/synapse', loeschen: true }, rueckweg: { skill: 'fernzugriff', aktion: 'kopieren', parameter: { quelle: 'neu', quelle_pfad: '/srv/matrix/synapse', ziel: 'dockerhost', ziel_pfad: rueckZiel, loeschen } } },
      ],
    });
    expect(pruefeChangePlan(mk('/home/synapse/data/', true), ctx()).fehler.join('\n')).toContain('Originalpfad');
    expect(pruefeChangePlan(mk('/srv/matrix-return/synapse', true), ctx()).fehler.join('\n')).not.toContain('Originalpfad');
    expect(pruefeChangePlan(mk('/home/synapse/data', false), ctx()).fehler.join('\n')).not.toContain('Originalpfad');
  });
});

// v1679 — Prüfbefehl mit Verweis wird nach dem Ersetzen eingeordnet (Realfall 26.10. Matrix E4)
describe('v1679 Verweise im Prüfbefehl', () => {
  it('docker image inspect …@{{schrittN.digest}} gilt als Leseliste', async () => {
    const { pruefbefehlFehler, ersetzeVerweise } = await import('./change-schritte.js');
    const b = "docker image inspect --format '{{json .RepoDigests}}' registry.lokalkraft.at/madh/alfred-ai/matrix-sydent@{{schritt3.digest}}";
    expect(pruefbefehlFehler(ersetzeVerweise(b))).toBeUndefined();
    expect(pruefbefehlFehler(ersetzeVerweise("docker network inspect --format '{{json .IPAM.Config}}' bridge"))).toMatch(/ohne Netz/);
  });
});

// v1680 — gezielte Schritt-Änderungen (Realfall 26.10. Matrix H/I)
describe('v1680 planMitSchrittAenderungen', () => {
  it('ersetzt einzelne Schritte, fügt ein und zieht Verweise nach', async () => {
    const { planMitSchrittAenderungen } = await import('./change-planung.js');
    const plan = { titel: 'x', schritte: [
      { nr: 1, titel: 'a', parameter: { v: 1 } },
      { nr: 2, titel: 'b', parameter: { image: 'r@{{schritt1.digest}}' } },
      { nr: 3, titel: 'c', parameter: { ref: '{{schritt2.id}} {{ schritt1.x }}' } },
    ] };
    const r = planMitSchrittAenderungen(plan, [{ nr: 1, schritt: { titel: 'A', parameter: { v: 2 } } }], [{ nach: 1, schritt: { titel: 'neu' } }]);
    expect('plan' in r).toBe(true);
    const s = (r as { plan: { schritte: Array<Record<string, unknown>> } }).plan.schritte;
    expect(s.map(x => x.titel)).toEqual(['A', 'neu', 'b', 'c']);
    expect(s.map(x => x.nr)).toEqual([1, 2, 3, 4]);
    expect((s[2]!.parameter as Record<string, string>).image).toBe('r@{{schritt1.digest}}');
    expect((s[3]!.parameter as Record<string, string>).ref).toBe('{{schritt3.id}} {{ schritt1.x }}');
    expect('fehler' in planMitSchrittAenderungen(plan, [{ nr: 9, schritt: {} }])).toBe(true);
    expect(plan.schritte[0]!.titel).toBe('a'); // Original unverändert
  });
  it('v1691 text_ersetzen: exakt, nur in den genannten Schritten, jeder muss den Text enthalten', async () => {
    const { planMitSchrittAenderungen } = await import('./change-planung.js');
    const befehl = (n: number) => `python3 -c 'print(dict(vm=${n},restore_sekunden=t["endtime"]-t["starttime"]))'`;
    const plan = { titel: 'x', schritte: [1, 2, 3].map(nr => ({ nr, titel: `s${nr}`, parameter: { befehl: befehl(nr) } })) };
    const r = planMitSchrittAenderungen(plan, undefined, undefined, [{ suchen: 'restore_sekunden=t["endtime"]-t["starttime"]', durch: 'restore_start=t["starttime"]', schritte: [1, 3] }]);
    const s = (r as { plan: { schritte: Array<{ parameter: { befehl: string } }> } }).plan.schritte;
    expect(s[0]!.parameter.befehl).toBe(`python3 -c 'print(dict(vm=1,restore_start=t["starttime"]))'`);
    expect(s[1]!.parameter.befehl).toBe(befehl(2));
    expect(s[2]!.parameter.befehl).toBe(`python3 -c 'print(dict(vm=3,restore_start=t["starttime"]))'`);
    const f = planMitSchrittAenderungen(plan, undefined, undefined, [{ suchen: 'gibtsnicht', durch: 'x', schritte: [2] }]);
    expect(f).toEqual({ fehler: ['text_ersetzen: „gibtsnicht“ kommt in Schritt 2 nicht vor'] });
    expect('fehler' in planMitSchrittAenderungen(plan, undefined, undefined, [{ suchen: 'vm=', durch: 'x' }])).toBe(true);
  });
});

// v1684 — Realfall 26.10. (Matrix J1): Prüfung/Schritt auf nicht vorhandenen Fernzugang
describe('v1684 Fernzugänge im Plan', () => {
  it('unbekannter Zugang wird abgewiesen, vorhandene und im Plan angelegte gelten', () => {
    const k = { ...ctx(), zugaenge: new Set(['dockerhost', 'pve3']) };
    const c = snapshotChange();
    c.schritte[3] = { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'udm', befehl: 'zpool status' } } as never;
    expect(pruefeChangePlan(c, k).fehler.join('\n')).toContain('Fernzugang „udm“ gibt es nicht');
    c.schritte[3] = { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'pve3', befehl: 'zpool status' } } as never;
    expect(pruefeChangePlan(c, k).fehler.join('\n')).not.toContain('gibt es nicht');
    // VM im selben Plan angelegt (Name als Parameter eines Nicht-Fernzugriff-Schritts) → Zugang gilt als vorhanden
    c.schritte[0] = { titel: 'VM', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 9001, name: 'neue-vm' } } as never;
    c.schritte[3] = { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'neue-vm', befehl: 'zpool status' } } as never;
    expect(pruefeChangePlan(c, k).fehler.join('\n')).not.toContain('gibt es nicht');
    // ohne Zugangsliste keine Prüfung
    c.schritte[3] = { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'udm', befehl: 'zpool status' } } as never;
    expect(pruefeChangePlan(c, ctx()).fehler.join('\n')).not.toContain('gibt es nicht');
  });
});

// v1685 — Realfall 26.10. (Matrix J wartet bei Owner-Schritt 19, die nötige Korrektur J1 wartete auf J): Korrektur auch bei wartet_owner
describe('v1685 Korrektur ab Haltepunkt bei wartendem Owner-Schritt', () => {
  it('ein auf den Owner wartender Change mit Wirkung ist ab dem Haltepunkt korrigierbar', async () => {
    const it3 = speicher();
    let korrekturAb: number | undefined;
    const orig = it3.setzeSchritte;
    it3.setzeSchritte = async (o: string, id: string, d: ChangeSchrittDaten, x?: { haltOhneWirkung?: boolean; korrekturAb?: number }) => { korrekturAb = x?.korrekturAb; return orig(o, id, d); };
    const pl = new ChangePlanung({ itsm: it3 as never, skill: n => SKILLS[n] as never, assets: async () => assets, auswirkung: keineAuswirkung });
    const ok = await pl.planen('o', [snapshotChange()]);
    if (!ok.ok) throw new Error('planen');
    const c = it3.db.get(ok.changes[0]!.id)!;
    Object.assign(c, { status: 'in_progress', lauf: { phase: 'wartet_owner', schritt: 4, ergebnisse: [{ nr: 3, ok: true, aktionOk: true }] } }); // Schritt 3 (löschen) hat gewirkt
    const r = await pl.aendern('o', c.id, snapshotChange());
    expect(r.ok).toBe(true);
    expect(korrekturAb).toBe(4);
  });
});
