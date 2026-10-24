import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { ChangeMotor, type MotorDeps } from './change-motor.js';
import { loeseAuf, pfadWert, restWirkung, rueckwegSchritte, textErfuellt, type ChangeLauf } from './change-lauf.js';
import type { ChangeSchritt } from './change-schritte.js';

// I4 — Ausführungsmotor gegen Attrappen (kein echter Host)
const S = (x: Partial<ChangeSchritt> & { nr: number }): ChangeSchritt => ({ titel: `S${x.nr}`, art: 'aktion', zeitlimitS: 60, beiFehler: 'anhalten', ...x });
const probe = (): ChangeSchritt[] => [
  S({ nr: 1, skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 142 }, einordnung: 'lesen' }),
  S({ nr: 2, skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 142, name: 'i3probe' }, einordnung: 'sicherung', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: 142 }, erwartet: 'i3probe' }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: 142, name: 'i3probe' } } }),
  S({ nr: 3, skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: '{{schritt2.vmid}}', name: 'i3probe' }, einordnung: 'aendern', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: 142 }, nichtEnthalten: 'i3probe' }, rueckweg: { keiner: 'Probe' } }),
  S({ nr: 4, art: 'pruefung', pruefung: { typ: 'ping', ziel: '192.168.1.96' } }),
];

function welt(schritte: ChangeSchritt[], opts: { snapshotFehlt?: boolean; status?: string } = {}) {
  const snaps = new Set<string>();
  const aufrufe: string[] = []; const meldungen: string[] = []; const fragen: Array<{ d: string; p: Record<string, unknown> }> = [];
  const c: CmdbChangeRequest = { id: 'chg-1', userId: 'o', title: 'Probe', type: 'normal', status: (opts.status ?? 'approved') as never, riskLevel: 'low', affectedAssetIds: ['a-vm'], affectedServiceIds: [], schritte, fingerabdruck: 'fp', freigabeFingerabdruck: 'fp', createdAt: 'x', updatedAt: 'x' };
  const deps: MotorDeps = {
    owner: () => 'o',
    itsm: {
      liste: async () => [c], hole: async () => c,
      motorSetze: async (_o, _id, d) => { if (d.status) c.status = d.status; c.lauf = JSON.parse(JSON.stringify(d.lauf)); if (d.result !== undefined) c.result = d.result; if (d.linkedIncidentId) c.linkedIncidentId = d.linkedIncidentId; return c; },
    },
    fuehreAus: async (skill, input) => {
      aufrufe.push(`${skill}.${String(input.action)}${input.name ? `:${String(input.name)}` : ''}`);
      if (input.action === 'create_snapshot') { if (!opts.snapshotFehlt) snaps.add(String(input.name)); return { success: true, data: { vmid: 142, upid: 'UPID:pve3:1:2:3:qmsnapshot:142:root@pam:' } }; }
      if (input.action === 'delete_snapshot') { snaps.delete(String(input.name)); return { success: true, data: { vmid: Number(input.vmid) } }; }
      if (input.action === 'task_status') return { success: true, data: { status: 'stopped', exitstatus: 'OK' } };
      if (input.action === 'list_snapshots') return { success: true, data: [...snaps].map(name => ({ name })) };
      return { success: true, data: { status: 'running', vmid: 142 }, display: 'läuft' };
    },
    fernLesen: async () => '', fernAusfuehren: async () => ({ code: 0, stdout: '', stderr: '' }),
    netz: { http: async () => ({ status: 200, text: '' }), port: async () => true, dns: async () => ['1.2.3.4'], ping: async () => true },
    cmdbProtokoll: async (_a, t) => { aufrufe.push(`cmdb:${t.slice(0, 30)}`); },
    entdecke: async q => q.map(x => `${x}: 1 Assets`),
    incident: { anlegen: async () => 'inc-1', notiz: async (_o, _id, t) => { aufrufe.push(`incident:${t.slice(0, 20)}`); }, loese: async (_o, id, t) => { aufrufe.push(`geloest:${id}:${t.slice(0, 60)}`); }, hochstufen: async (_o, id) => { aufrufe.push(`hoch:${id}`); } },
    melde: async t => { meldungen.push(t); },
    frage: async (d, p) => { fragen.push({ d, p }); return true; },
    schlafe: async () => undefined,
    takt: { pruefAbstandMs: 0, pruefVersuche: 2, taskAbstandMs: 0, wartenAbstandMs: 1 },
  };
  return { c, deps, motor: new ChangeMotor(deps), aufrufe, meldungen, fragen, snaps };
}
const warte = async (m: ChangeMotor) => { for (let i = 0; i < 50 && m.aktiv() > 0; i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 5)); };

describe('I4 Lauf-Bausteine', () => {
  it('Verweise behalten den Typ, Tresor geht noch nicht, Pfade, Textprüfung, Rückweg-Reihenfolge', () => {
    const erg = [{ nr: 2, ok: true, start: 'x', daten: { vmid: 142, vm: { ip: '10.0.0.5' } } }];
    expect(loeseAuf({ vmid: '{{schritt2.vmid}}', url: 'http://{{schritt2.vm.ip}}:8080' }, erg).wert).toEqual({ vmid: 142, url: 'http://10.0.0.5:8080' });
    expect(loeseAuf({ x: '{{schritt3.vmid}}' }, erg).fehler).toContain('hat keinen Wert');
    expect(loeseAuf({ pw: '{{geheim:db}}' }, erg).fehler).toContain('Tresor');
    expect(pfadWert({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
    expect(textErfuellt('Snapshot i3probe', { erwartet: 'I3PROBE' }).ok).toBe(true);
    expect(textErfuellt('Snapshot i3probe', { nichtEnthalten: 'i3probe' }).ok).toBe(false);
    const rw = rueckwegSchritte(probe(), [{ nr: 2, ok: true, start: 'x' }, { nr: 3, ok: false, aktionOk: true, start: 'x' }]);
    expect(rw.map(s => s.nr)).toEqual([2]); // Schritt 3 hat „keiner“
  });
});

describe('I4 Ausführungsmotor', () => {
  it('Probe-Change: Snapshot anlegen (Aufgabe verfolgt), prüfen, löschen, Abschluss mit Discovery, CMDB-Protokoll und Bericht', async () => {
    const w = welt(probe());
    expect(await w.motor.anstossen()).toEqual(['chg-1']);
    await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect(w.aufrufe).toEqual(expect.arrayContaining(['proxmox.create_snapshot:i3probe', 'proxmox.task_status', 'proxmox.delete_snapshot:i3probe']));
    expect(w.aufrufe.filter(a => a.startsWith('cmdb:')).length).toBe(2);
    expect(w.snaps.size).toBe(0);
    expect(w.c.result).toContain('Probe: abgeschlossen');
    expect(w.c.result).toContain('Discovery danach: proxmox: 1 Assets');
    expect((w.c.lauf as ChangeLauf).ergebnisse.map(e => e.ok)).toEqual([true, true, true, true]);
    expect(w.meldungen[0]).toContain('Change gestartet');
    expect(w.meldungen.at(-1)).toContain('✅');
  });

  it('Prüfung scheitert → anhalten, Incident, KEINE Rückweg-Frage (Owner 22.10.); Rückweg nur ausdrücklich per steuern', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    const l = w.c.lauf as ChangeLauf;
    expect(w.c.status).toBe('in_progress');
    expect(l.phase).toBe('angehalten');
    expect(l.incidentId).toBe('inc-1');
    expect(w.aufrufe).not.toContain('proxmox.delete_snapshot:i3probe'); // kein Rückweg von selbst
    expect(w.fragen).toEqual([]); // keine Ja/Nein-Frage mehr
    const m = w.meldungen.find(x => x.includes('angehalten'))!;
    expect(m).toContain('Schritt wiederholen');
    expect(m).toContain('Rückweg ausführen');
    expect(m).toContain('delete_snapshot');
    expect(await w.motor.rueckwegNachJa('o', 'chg-1', 'irgendwas')).toContain('Keine offene Frage'); // alter Weg ohne gültige Frage wirkt nicht
    expect(await w.motor.steuern('o', 'chg-1', 'rueckweg')).toContain('Rückweg läuft');
    await warte(w.motor);
    expect(w.c.status).toBe('rolled_back');
    expect(w.aufrufe).toContain('proxmox.delete_snapshot:i3probe');
    expect(w.aufrufe.some(a => a.startsWith('incident:Rückweg ausgeführt'))).toBe(true);
  });

  it('beiFehler rueckweg (im Plan freigegeben) läuft ohne Frage; wiederholen und abbrechen im angehaltenen Zustand', async () => {
    const plan = probe(); plan[1]!.beiFehler = 'rueckweg';
    const w = welt(plan, { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('rolled_back');
    expect(w.fragen).toEqual([]);
    const w2 = welt(probe(), { snapshotFehlt: true });
    await w2.motor.anstossen(); await warte(w2.motor);
    expect(await w2.motor.steuern('o', 'chg-1', 'abbrechen')).toContain('abgebrochen');
    expect(w2.c.status).toBe('cancelled');
  });

  it('wiederholen nach gelungener Aktion mit gescheiterter Prüfung: nur die Prüfung läuft neu (Realfall 4dc47fa3 — Download „gibt es schon“)', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    w.snaps.add('i3probe'); // Prüfung wäre jetzt erfüllt (z. B. Leseliste korrigiert)
    expect(await w.motor.steuern('o', 'chg-1', 'wiederholen')).toContain('nur die Prüfung');
    await warte(w.motor);
    expect(w.aufrufe.filter(a => a === 'proxmox.create_snapshot:i3probe')).toHaveLength(1);
    expect(w.c.status).toBe('completed');
    expect((w.c.lauf as ChangeLauf).ergebnisse.find(e => e.nr === 2)).toMatchObject({ ok: true, aktionOk: true, daten: { vmid: 142 } });
  });

  it('v1620 Realfall 23.10.: der Halt-Incident endet mit dem Change — zurückgerollt, nach Wiederholen abgeschlossen, abgebrochen ohne Wirkung', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    await w.motor.steuern('o', 'chg-1', 'rueckweg'); await warte(w.motor);
    expect(w.c.status).toBe('rolled_back');
    expect(w.aufrufe.some(a => a.startsWith('geloest:inc-1:Change chg-1 vollständig zurückgerollt'))).toBe(true);
    expect(w.c.linkedIncidentId).toBe('inc-1');
    const w2 = welt(probe(), { snapshotFehlt: true });
    await w2.motor.anstossen(); await warte(w2.motor);
    w2.snaps.add('i3probe');
    await w2.motor.steuern('o', 'chg-1', 'wiederholen'); await warte(w2.motor);
    expect(w2.c.status).toBe('completed');
    expect(w2.aufrufe.some(a => a.startsWith('geloest:inc-1:Change chg-1 nach dem Anhalten abgeschlossen'))).toBe(true);
    const w3 = welt(probe(), { snapshotFehlt: true });
    await w3.motor.anstossen(); await warte(w3.motor);
    await w3.motor.steuern('o', 'chg-1', 'abbrechen');
    expect(w3.c.status).toBe('cancelled');
    expect(w3.aufrufe.some(a => a.startsWith('geloest:inc-1:Change chg-1 ohne verbliebene Wirkung'))).toBe(true); // Snapshot zählt nicht als Restwirkung
    expect(w3.aufrufe.some(a => a.startsWith('hoch:'))).toBe(false);
  });

  it('v1630 Realfall 24.10.: gescheiterte Aktion, die schon etwas angelegt hat (Daten trotz Fehler) → teilweise, Rückweg läuft mit', async () => {
    const w = welt(probe());
    const orig = w.deps.fuehreAus;
    w.deps.fuehreAus = async (skill, input, t) => {
      if (input.action === 'create_snapshot') { w.aufrufe.push('proxmox.create_snapshot:i3probe'); w.snaps.add('i3probe'); return { success: false, error: 'VM angelegt, Anmeldung gescheitert', data: { vmid: 142 } }; }
      return orig(skill, input, t);
    };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    const l = w.c.lauf as ChangeLauf;
    expect(l.phase).toBe('angehalten');
    expect(l.ergebnisse.find(e => e.nr === 2)).toMatchObject({ ok: false, teilweise: true, daten: { vmid: 142 } });
    await m.steuern('o', 'chg-1', 'rueckweg'); await warte(m);
    expect(w.aufrufe).toContain('proxmox.delete_snapshot:i3probe');
    expect(w.snaps.size).toBe(0);
    expect(w.c.status).toBe('rolled_back');
  });

  it('v1620: Restwirkung = ausgeführte Änderung ohne gelungenen Rückweg (Sicherungen zählen nicht) → Incident bleibt offen und wird hoch', async () => {
    const plan = probe(); plan[2]!.rueckweg = { skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 142, name: 'i3probe' } };
    expect(restWirkung(probe(), { phase: 'fertig', schritt: 3, start: 'x', ergebnisse: [{ nr: 3, ok: true, start: 'x' }] } as ChangeLauf)).toEqual([]); // „kein Rückweg“ = freigegebene Wirkung
    const l = (rw: Array<{ zuSchritt: number; ok: boolean }>): ChangeLauf => ({ phase: 'fertig', schritt: 3, start: 'x', ergebnisse: [{ nr: 2, ok: true, start: 'x' }, { nr: 3, ok: false, aktionOk: true, start: 'x' }], rueckweg: rw.map(r => ({ ...r, text: '', zeit: 'x' })) }) as ChangeLauf;
    expect(restWirkung(plan, l([])).map(s => s.nr)).toEqual([3]);
    expect(restWirkung(plan, l([{ zuSchritt: 3, ok: true }]))).toEqual([]);
    expect(restWirkung(plan, l([{ zuSchritt: 3, ok: false }])).map(s => s.nr)).toEqual([3]);
    // Abbruch nach einer wirksamen Änderung: Schritt 3 löscht den Snapshot, Prüfung scheitert (Snapshot kommt wieder) → angehalten mit Wirkung
    const w = welt(plan);
    w.deps.fuehreAus = async (skill, input) => { w.aufrufe.push(`${skill}.${String(input.action)}`); if (input.action === 'list_snapshots') return { success: true, data: [{ name: 'i3probe' }] }; if (input.action === 'task_status') return { success: true, data: { status: 'stopped', exitstatus: 'OK' } }; return { success: true, data: { vmid: 142 } }; };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect((w.c.lauf as ChangeLauf).schritt).toBe(3);
    await m.steuern('o', 'chg-1', 'abbrechen');
    expect(w.aufrufe.some(a => a.startsWith('geloest:'))).toBe(false);
    expect(w.aufrufe).toContain('hoch:inc-1');
    expect(w.aufrufe.some(a => a.startsWith('incident:Change-Ende: cancel'))).toBe(true);
  });

  it('v1604 Realfall 9527d97f: wartet auf einen angehaltenen, schon wirksamen Change → einmal melden, nicht still warten', async () => {
    const w = welt(probe());
    const blocker = { ...w.c, id: 'chg-0aaaaaaa', title: 'pgAdmin erreichbar', status: 'in_progress', lauf: { phase: 'angehalten', schritt: 3, ergebnisse: [{ nr: 2, ok: false, aktionOk: true }] } } as unknown as CmdbChangeRequest;
    w.deps.itsm.liste = async () => [w.c, blocker];
    expect(await w.motor.anstossen()).toEqual([]);
    expect(await w.motor.anstossen()).toEqual([]);
    const m = w.meldungen.filter(x => x.includes('startet aber nicht'));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('chg-0aaa');
    expect(m[0]).toContain('abbrechen');
  });

  it('v1605: nach dem Abbruch des angehaltenen Changes startet der wartende sofort, nicht erst im nächsten Takt', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    const zweiter = { ...w.c, id: 'chg-2', title: 'wartet', status: 'approved', lauf: undefined } as unknown as CmdbChangeRequest;
    const liste = w.deps.itsm.liste;
    w.deps.itsm.liste = async (o: string) => [...(await liste(o)), zweiter];
    expect(await w.motor.anstossen()).toEqual([]);
    const gestartet: string[] = [];
    const alt = w.motor.anstossen.bind(w.motor);
    w.motor.anstossen = async () => { const r = await alt(); gestartet.push(...r); return r; };
    await w.motor.steuern('o', 'chg-1', 'abbrechen');
    await new Promise(r => setTimeout(r, 20));
    expect(gestartet).toContain('chg-2');
  });

  it('Owner-Schritt wartet auf das Ja; Start nur mit gültiger Freigabe, nicht vor dem Termin, nicht bei belegtem Asset', async () => {
    const plan: ChangeSchritt[] = [S({ nr: 1, art: 'owner', frage: 'VLAN 821 in UniFi anlegen' }), S({ nr: 2, art: 'pruefung', pruefung: { typ: 'ping', ziel: 'x' } })];
    const w = welt(plan);
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('wartet_owner');
    expect(await w.motor.ownerSchrittErledigt('o', 'chg-1', 1, w.fragen[0]!.p.freigabe)).toContain('läuft weiter');
    await warte(w.motor);
    expect(w.c.status).toBe('completed');
    const spaeter = welt(probe()); spaeter.c.scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    expect(await spaeter.motor.anstossen()).toEqual([]);
    const belegt = welt(probe());
    belegt.deps.itsm.liste = async () => [belegt.c, { ...belegt.c, id: 'chg-0', status: 'in_progress', lauf: { phase: 'laeuft' } } as CmdbChangeRequest];
    expect(await belegt.motor.anstossen()).toEqual([]);
  });

  it('Realfall 22.10.: angehalten ohne Wirkung sperrt keine Assets; angehalten nach einer Änderung schon', async () => {
    const leer = welt(probe());
    leer.deps.itsm.liste = async () => [leer.c, { ...leer.c, id: 'chg-0', status: 'in_progress', lauf: { phase: 'angehalten', schritt: 1, start: 'x', ergebnisse: [{ nr: 1, ok: false, start: 'x' }] } } as CmdbChangeRequest];
    expect(await leer.motor.anstossen()).toEqual(['chg-1']);
    await warte(leer.motor);
    const gewirkt = welt(probe());
    gewirkt.deps.itsm.liste = async () => [gewirkt.c, { ...gewirkt.c, id: 'chg-0', status: 'in_progress', lauf: { phase: 'angehalten', schritt: 3, start: 'x', ergebnisse: [{ nr: 1, ok: true, start: 'x' }, { nr: 2, ok: true, aktionOk: true, start: 'x' }] } } as CmdbChangeRequest];
    expect(await gewirkt.motor.anstossen()).toEqual([]);
  });

  it('Neustart mitten in einem ändernden Schritt → anhalten und fragen; in einem lesenden → fortsetzen', async () => {
    const w = welt(probe(), { status: 'in_progress' });
    w.c.lauf = { phase: 'laeuft', schritt: 3, start: new Date().toISOString(), ergebnisse: [{ nr: 1, ok: true, start: 'x' }, { nr: 2, ok: true, aktionOk: true, start: 'x', daten: { vmid: 142 } }] } satisfies ChangeLauf;
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    expect((w.c.lauf as ChangeLauf).grund).toContain('Neustart während Schritt 3');
    const l = welt(probe(), { status: 'in_progress' });
    l.c.lauf = { phase: 'laeuft', schritt: 1, start: new Date().toISOString(), ergebnisse: [] } satisfies ChangeLauf;
    await l.motor.anstossen(); await warte(l.motor);
    expect(l.c.status).toBe('completed');
  });
});

describe('I4 Sicherheitsbefund: Verweise in Befehlen', () => {
  it('Shell-Zeichen aus Ausgaben werden nicht eingesetzt; ganzer Befehl aus Verweis ist verboten', () => {
    const erg = [{ nr: 1, ok: true, start: 'x', daten: { ip: '10.0.0.5', boese: '1; rm -rf /', name: 'a b' } }];
    expect(loeseAuf({ befehl: 'ping -c1 {{schritt1.ip}}' }, erg)).toEqual({ wert: { befehl: 'ping -c1 10.0.0.5' } });
    expect(loeseAuf({ befehl: 'docker restart {{schritt1.boese}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ befehl: '{{schritt1.ip}}' }, erg).fehler).toContain('ganzer Befehl');
    expect(loeseAuf({ name: '{{schritt1.name}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ vmid: '{{schritt1.ip}}' }, erg).wert).toEqual({ vmid: '10.0.0.5' });
  });
});

describe('I4 Sicherheitsbefund: Freigabe vor jedem Schritt', () => {
  it('geänderter Fingerabdruck nach Neustart → anhalten, nichts ausführen', async () => {
    const w = welt(probe(), { status: 'in_progress' });
    w.c.lauf = { phase: 'laeuft', schritt: 1, start: new Date().toISOString(), ergebnisse: [] } satisfies ChangeLauf;
    w.c.fingerabdruck = 'anders';
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    expect((w.c.lauf as ChangeLauf).grund).toContain('Fingerabdruck geändert');
    expect(w.aufrufe.filter(a => a.startsWith('proxmox.'))).toEqual([]);
  });
});

describe('I4b Motor wartet auf den Zeitplan', () => {
  it('zeitplan nein → nicht starten; ja → starten', async () => {
    const w = welt(probe());
    w.deps.zeitplan = async () => ({ jetzt: false, grund: 'außerhalb der Wartungsfenster' });
    expect(await w.motor.anstossen()).toEqual([]);
    expect(w.c.status).toBe('approved');
    const ereignisse: string[] = [];
    w.deps.zeitplan = async () => ({ jetzt: true, grund: 'im Fenster' });
    w.deps.ereignis = async (_o, _c, z) => { ereignisse.push(z); };
    const m2 = new ChangeMotor(w.deps);
    expect(await m2.anstossen()).toEqual(['chg-1']);
    await warte(m2);
    expect(w.c.status).toBe('completed');
    expect(ereignisse).toEqual(['start', 'ende']);
  });
});

describe('I4b Störung nach Change (Owner 5b-13: Rückweg nur vorschlagen)', () => {
  it('Incident an abhängigem Asset binnen 24 h → verknüpft, Meldung (keine Frage), Rückweg nur ausdrücklich; danach zurückgerollt', async () => {
    const w = welt(probe());
    w.deps.abhaengigeIds = async () => ['a-dienst'];
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('completed');
    const ende = (w.c.lauf as ChangeLauf).ende!;
    const spaeter = new Date(Date.parse(ende) + 3_600_000).toISOString();
    const vorher = new Date(Date.parse(ende) - 60_000).toISOString();
    w.deps.jetzt = () => Date.parse(spaeter) + 60_000;
    const m = new ChangeMotor(w.deps);
    expect(await m.pruefeStoerungen([
      { id: 'i-alt', title: 'schon vorher', severity: 'high', status: 'open', affectedAssetIds: ['a-vm'], createdAt: vorher },
      { id: 'i-fremd', title: 'woanders', severity: 'high', status: 'open', affectedAssetIds: ['a-anders'], createdAt: spaeter },
      { id: 'i-1', title: 'Dienst down', severity: 'critical', status: 'open', affectedAssetIds: ['a-dienst'], createdAt: spaeter },
    ])).toBe(1);
    const l = w.c.lauf as ChangeLauf;
    expect(l.stoerungen?.map(s => s.incidentId)).toEqual(['i-1']);
    // Probe-Plan hat einen Rückweg zu Schritt 2 → nur Meldung mit dem Chat-Befehl, keine Frage, nichts ausgeführt
    expect(w.fragen).toEqual([]);
    expect(w.meldungen.at(-1)).toContain('Störung möglicherweise durch Change');
    expect(w.meldungen.at(-1)).toContain('Rückweg ausführen');
    expect(w.c.status).toBe('completed');
    expect(await m.pruefeStoerungen([{ id: 'i-1', title: 'Dienst down', severity: 'critical', status: 'open', affectedAssetIds: ['a-dienst'], createdAt: spaeter }])).toBe(0); // nicht doppelt
    expect(await m.steuern('o', 'chg-1', 'rueckweg')).toContain('Rückweg läuft');
    await warte(m);
    expect(w.c.status).toBe('rolled_back');
  });
  it('Realfall 22.10.: der Halt-Incident eines anderen Changes wird nie dem abgeschlossenen Change zugeschrieben', async () => {
    const w = welt(probe());
    await w.motor.anstossen(); await warte(w.motor);
    const ende = Date.parse((w.c.lauf as ChangeLauf).ende!);
    const spaeter = new Date(ende + 600_000).toISOString();
    // ein zweiter Change auf demselben Asset hielt an; sein Incident steht in seinem Lauf
    const b = { ...w.c, id: 'chg-2', status: 'in_progress', lauf: { phase: 'angehalten', schritt: 1, start: spaeter, ergebnisse: [], incidentId: 'i-halt' } } as CmdbChangeRequest;
    w.deps.itsm.liste = async () => [w.c, b];
    w.deps.jetzt = () => ende + 900_000;
    const m = new ChangeMotor(w.deps);
    const fragenVorher = w.fragen.length;
    expect(await m.pruefeStoerungen([{ id: 'i-halt', title: 'Change angehalten: B', severity: 'medium', status: 'open', affectedAssetIds: ['a-vm'], createdAt: spaeter }])).toBe(0);
    expect(w.fragen.length).toBe(fragenVorher);
    expect((w.c.lauf as ChangeLauf).stoerungen ?? []).toEqual([]);
  });
  it('außerhalb des Zeitfensters (25 h, nicht kritisch) → nichts', async () => {
    const w = welt(probe());
    await w.motor.anstossen(); await warte(w.motor);
    const ende = Date.parse((w.c.lauf as ChangeLauf).ende!);
    w.deps.jetzt = () => ende + 25 * 3_600_000;
    expect(await new ChangeMotor(w.deps).pruefeStoerungen([{ id: 'i', title: 'x', severity: 'high', status: 'open', affectedAssetIds: ['a-vm'], createdAt: new Date(ende + 25 * 3_600_000).toISOString() }])).toBe(0);
  });
});

// Realfall 22.10. (733bbe87 wartete auf den 10-Minuten-Takt): abhängiger Change startet gleich nach dem Abschluss
describe('Folge-Change', () => {
  it('startet direkt nach dem Abschluss des Changes, von dem er abhängt', async () => {
    const w = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'ping', ziel: 'x' } })]);
    const b = { ...w.c, id: 'chg-2', status: 'approved', abhaengigVon: ['chg-1'], lauf: undefined, schritte: [S({ nr: 1, art: 'pruefung', pruefung: { typ: 'ping', ziel: 'y' } })] } as CmdbChangeRequest;
    const alle = [w.c, b];
    w.deps.itsm.liste = async () => alle;
    w.deps.itsm.hole = async (_o, id) => alle.find(x => x.id === id) ?? null;
    w.deps.itsm.motorSetze = async (_o, id, d) => { const x = alle.find(y => y.id === id)!; if (d.status) x.status = d.status; x.lauf = JSON.parse(JSON.stringify(d.lauf)); return x; };
    const m = new ChangeMotor(w.deps);
    expect(await m.anstossen()).toEqual(['chg-1']); // chg-2 wartet auf chg-1
    await warte(m); await warte(m);
    expect(w.c.status).toBe('completed');
    expect(b.status).toBe('completed');
  });
});
