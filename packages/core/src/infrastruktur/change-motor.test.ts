import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { ChangeMotor, ownerFrageVeraltet, ueberspringbar, type MotorDeps } from './change-motor.js';
import { loeseAuf, merkeVerlauf, pfadWert, restWirkung, rueckwegSchritte, textErfuellt, unaufgeloesterVerweis, kuerzeDaten, MAX_DATEN, BASE64_DATEN_MAX, BASE64_DATEN_SUMME, type ChangeLauf } from './change-lauf.js';
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
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
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

  it('v1651 Realfall 5d960660/937e4aac: nach Halt ohne Wirkung neu geplant und gelaufen → der alte Halt-Incident wird gelöst', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).incidentId).toBe('inc-1');
    // Neuplanung (setzeSchritte mit haltOhneWirkung): Lauf verworfen, Incident bleibt am Change, neue Freigabe
    w.c.linkedIncidentId = 'inc-1'; w.c.lauf = undefined; w.c.status = 'approved' as never; w.snaps.add('i3probe');
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect(w.aufrufe.some(a => a.startsWith('geloest:inc-1:'))).toBe(true);
  });

  it('v1652 Realfall 7d873ad4: Datei-Prüfung nutzt nur Metadaten — ein Geheimnis-Pfad scheitert nicht an der Inhalts-Sperre', async () => {
    const w = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'datei', zugang: 'pve3', pfad: '/mnt/pve/backupshare/vaultwarden-20261025/vaultwarden.tar.enc' } })]);
    w.deps.fernLesen = async () => { throw new Error('berührt Geheimnisse'); };
    const gefragt: string[] = [];
    w.deps.fernDatei = async (z, p) => { gefragt.push(`${z}:${p}`); return 'regular file 460918'; };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(w.c.status).toBe('completed');
    expect(gefragt).toEqual(['pve3:/mnt/pve/backupshare/vaultwarden-20261025/vaultwarden.tar.enc']);
    const w2 = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'datei', zugang: 'pve3', pfad: '/fehlt' } })]);
    w2.deps.fernDatei = async () => { throw new Error('nicht vorhanden'); };
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    expect((w2.c.lauf as ChangeLauf).phase).toBe('angehalten');
  });

  it('v1661 Realfall 0cd5c0a4: ab dem Haltepunkt korrigiert → weiter erst mit neuer Freigabe, dann am Haltepunkt ohne Wiederholung der früheren Schritte', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    const l = w.c.lauf as ChangeLauf;
    expect(l.phase).toBe('angehalten');
    const haltepunkt = l.schritt;
    const vorher = w.aufrufe.length;
    // Korrektur gespeichert: neuer Plan, Freigabe verfallen
    l.korrektur = { abSchritt: haltepunkt, zeit: 'x' };
    Object.assign(w.c, { fingerabdruck: 'neu', freigabeFingerabdruck: 'alt' });
    expect(await w.motor.steuern('o', 'chg-1', 'wiederholen')).toContain('wartet auf deine Freigabe');
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
    // Owner gibt den korrigierten Plan frei → der Motor macht am Haltepunkt weiter
    w.c.freigabeFingerabdruck = 'neu'; w.snaps.add('i3probe');
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect((w.c.lauf as ChangeLauf).korrektur).toBeUndefined();
    expect(w.aufrufe.slice(vorher).filter(a => a.startsWith('proxmox.vm_status')).length).toBeLessThanOrEqual(1); // Schritt 1 lief nicht erneut als Aktion
    expect(w.meldungen.some(m => m.includes('Korrektur freigegeben'))).toBe(true);
  });

  it('v1764 Realfall 91eb7ee9: „QEMU guest agent is not running“ → Schritt wird nach Pause wiederholt; andere Fehler nicht', async () => {
    const lauf = async (antworten: Array<{ code: number; stdout: string; stderr: string }>) => {
      const w = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'pve3', befehl: 'qm guest exec 130 -- powershell -Command Confirm-SecureBootUEFI' }, einordnung: 'aendern', rueckweg: { keiner: 'nur lesen' } })]);
      let n = 0;
      w.deps.fernAusfuehren = async () => antworten[Math.min(n++, antworten.length - 1)]!;
      const m = new ChangeMotor(w.deps);
      await m.anstossen(); await warte(m);
      return { status: w.c.status, aufrufe: n };
    };
    const weg = { code: 1, stdout: 'QEMU guest agent is not running', stderr: '' }, gut = { code: 0, stdout: 'True', stderr: '' };
    expect(await lauf([weg, weg, gut])).toEqual({ status: 'completed', aufrufe: 3 });
    const anders = await lauf([{ code: 1, stdout: '', stderr: 'Zugriff verweigert' }, gut]);
    expect(anders.aufrufe).toBe(1);
    expect(anders.status).not.toBe('completed');
  });

  it('v1761 Realfall 36d4ae7b: Proxmox-Aufgabe mit „WARNINGS: 1“ gilt als gelungen, ein Fehler weiter nicht', async () => {
    const lauf = async (exitstatus: string) => {
      const w = welt([S({ nr: 1, skill: 'proxmox', aktion: 'vm_start', parameter: { vmid: 9102 }, einordnung: 'aendern' })]);
      w.deps.fuehreAus = async (_s, input) => input.action === 'task_status'
        ? { success: true, data: { status: 'stopped', exitstatus } }
        : { success: true, display: 'gestartet', data: { upid: 'UPID:pve:1:2:3:qmstart:9102:root@pam:' } };
      const m = new ChangeMotor(w.deps);
      await m.anstossen(); await warte(m);
      return w.c;
    };
    const gut = await lauf('WARNINGS: 1');
    expect(gut.status).toBe('completed');
    expect((gut.lauf as ChangeLauf).ergebnisse[0]?.ausgabe).toContain('WARNINGS: 1');
    expect(((await lauf('unable to start VM')).lauf as ChangeLauf).phase).toBe('angehalten');
  });

  it('v1759 Realfall 25958184: Aktion am Haltepunkt korrigiert → die neue Aktion läuft, nicht nur die Prüfung', async () => {
    const lauf = async (aktionGeaendert: boolean) => {
      const w = welt(probe(), { snapshotFehlt: true });
      await w.motor.anstossen(); await warte(w.motor);
      const l = w.c.lauf as ChangeLauf;
      expect(l.phase).toBe('angehalten');
      expect(l.ergebnisse.find(e => e.nr === l.schritt)?.aktionOk).toBe(true); // Aktion gelungen, Prüfung gescheitert
      const vorher = w.aufrufe.filter(a => a.startsWith('proxmox.create_snapshot')).length;
      l.korrektur = { abSchritt: l.schritt, zeit: 'x', ...(aktionGeaendert ? { aktionGeaendert: true } : {}) };
      Object.assign(w.c, { fingerabdruck: 'neu', freigabeFingerabdruck: 'neu' });
      w.snaps.add('i3probe');
      await w.motor.anstossen(); await warte(w.motor);
      expect(w.c.status).toBe('completed');
      return w.aufrufe.filter(a => a.startsWith('proxmox.create_snapshot')).length - vorher;
    };
    expect(await lauf(false)).toBe(0); // unveränderte Aktion: nur die Prüfung (nicht doppelt)
    expect(await lauf(true)).toBe(1); // korrigierte Aktion: läuft neu
  });

  it('v1643 Realfall 4c5652a5: Skill-Prüfung durchsucht nur Werte, nicht Feldnamen (leeres „gesperrt“ ist kein GESPERRT)', async () => {
    const w = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'skill', skill: 'unifi', aktion: 'trunk_path', nichtEnthalten: 'GESPERRT', erwartet: 'VLAN 825' } })]);
    w.deps.fuehreAus = async () => ({ success: true, display: 'Weg für Docker-Betrieb (VLAN 825):\n- Port 9: custom — durchgelassen\nAlle Ports lassen das Netz durch.', data: { netz: 'Docker-Betrieb', vlan: 825, pfad: [{ port: 9, durch: true }], gesperrt: [] } });
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(w.c.status).toBe('completed');
    const w2 = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'skill', skill: 'unifi', aktion: 'trunk_path', nichtEnthalten: 'GESPERRT' } })]);
    w2.deps.fuehreAus = async () => ({ success: true, display: 'Port 9: custom — GESPERRT', data: { gesperrt: [{ port: 9 }] } });
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    expect((w2.c.lauf as ChangeLauf).phase).toBe('angehalten');
  });

  it('v1717 Realfall 8a26aed6: fernzugriff.lesen als Prüfung — nur stdout zählt, Exit ≠ 0 ist nicht erfüllt', async () => {
    const befehl = `python3 -c 'print("ZEIT_ERREICHT" if ok else "WARTEN")'`;
    const lauf = (code: number, stdout: string) => async () => ({ success: true, display: `\`\`\`\npg-repo-01$ ${befehl}${code ? `  (Exit ${code})` : ''}\n${stdout}\`\`\``, data: { name: 'pg-repo-01', befehl, code, stdout, stderr: '' } });
    const w = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'skill', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: 'pg-repo-01', befehl }, erwartet: 'ZEIT_ERREICHT' } })]);
    w.deps.fuehreAus = lauf(1, 'WARTEN\n');
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten'); // vorher: Befehlstext enthielt „ZEIT_ERREICHT“ → fälschlich erfüllt
    const w2 = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'skill', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: 'pg-repo-01', befehl }, erwartet: 'ZEIT_ERREICHT' } })]);
    w2.deps.fuehreAus = lauf(0, 'WARTEN\n');
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    expect((w2.c.lauf as ChangeLauf).phase).toBe('angehalten'); // Exit 0, aber Ausgabe WARTEN
    const w3 = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'skill', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: 'pg-repo-01', befehl }, erwartet: 'ZEIT_ERREICHT' } })]);
    w3.deps.fuehreAus = lauf(0, 'ZEIT_ERREICHT\n');
    const m3 = new ChangeMotor(w3.deps);
    await m3.anstossen(); await warte(m3);
    expect(w3.c.status).toBe('completed');
  });

  it('v1718 Realfall 8a26aed6 Schritt 67: Warten endet sofort, wenn der Abbruch-Text in der Ausgabe steht', async () => {
    const w = welt([S({ nr: 1, art: 'warten', zeitlimitS: 3600, pruefung: { typ: 'befehl', zugang: 'pg-repo-01', befehl: 'pg-b-verify-state', erwartet: 'VERIFIED_OK', abbruch: 'VERIFY_FAILED' } })]);
    let aufrufe = 0;
    w.deps.fernLesen = async () => { aufrufe++; return 'VERIFY_FAILED exit=1\n'; };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    expect(aufrufe).toBe(1); // nicht 3600 s / Takt lang weiterprüfen
  });

  it('v1729: Warte-Schritt prüft gestaffelt (2, 2, 3, 5 s, dann Grundtakt 10 s)', async () => {
    const w = welt([S({ nr: 1, art: 'warten', zeitlimitS: 600, pruefung: { typ: 'befehl', zugang: 'pg-repo-01', befehl: 'systemctl is-active x', erwartet: 'active' } })]);
    w.deps.takt = { pruefAbstandMs: 0, pruefVersuche: 2, taskAbstandMs: 0, wartenAbstandMs: 10_000 };
    const abstaende: number[] = [];
    w.deps.schlafe = async ms => { abstaende.push(ms); };
    let n = 0;
    w.deps.fernLesen = async () => (++n >= 7 ? 'active\n' : 'activating\n');
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(w.c.status).toBe('completed');
    expect(abstaende).toEqual([2000, 2000, 3000, 5000, 10_000, 10_000]);
  });

  it('v1787 Realfall a053cec2 Schritt 5: Aktion mit langem Zeitlimit wartet mit ihrer Prüfung bis zum Abschluss', async () => {
    const pr = { typ: 'befehl' as const, zugang: 'pve2', befehl: 'systemctl status alfred-pbs-gc --no-pager', erwartet: 'active (exited)', abbruch: 'Active: failed' };
    const w = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'ausfuehren', zeitlimitS: 14400, einordnung: 'aendern', parameter: { name: 'pve2', befehl: 'systemd-run --unit=alfred-pbs-gc -r proxmox-backup-manager garbage-collection start backup' }, pruefung: pr, rueckweg: { keiner: 'Test' } })]);
    w.deps.takt = { pruefAbstandMs: 0, pruefVersuche: 2, taskAbstandMs: 0, wartenAbstandMs: 10_000 };
    w.deps.schlafe = async () => undefined;
    w.deps.fernAusfuehren = async () => ({ code: 0, stdout: '', stderr: '' });
    let n = 0;
    w.deps.fernLesen = async () => (++n >= 9 ? 'Active: active (exited)\n' : 'Active: active (running)\n');
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(w.c.status).toBe('completed');
    expect(n).toBe(9);
    // abbruch endet sofort
    const w2 = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'ausfuehren', zeitlimitS: 14400, einordnung: 'aendern', parameter: { name: 'pve2', befehl: 'systemd-run --unit=alfred-pbs-gc -r proxmox-backup-manager garbage-collection start backup' }, pruefung: pr, rueckweg: { keiner: 'Test' } })]);
    w2.deps.takt = w.deps.takt; w2.deps.schlafe = async () => undefined; w2.deps.fernAusfuehren = async () => ({ code: 0, stdout: '', stderr: '' });
    let k = 0;
    w2.deps.fernLesen = async () => { k++; return 'Active: failed (Result: exit-code)\n'; };
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    expect((w2.c.lauf as ChangeLauf).phase).toBe('angehalten');
    expect(k).toBe(1);
  });

  it('v1719 Realfall 8a26aed6 Schritt 73: Fernzugriff-Aktion bekommt das Schrittlimit als timeout_s', async () => {
    const w = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'kopieren', zeitlimitS: 10800, einordnung: 'aendern', parameter: { quelle: 'pg-repo-01', quelle_pfad: '/a', ziel: 'pg-restore-01', ziel_pfad: '/b' }, rueckweg: { keiner: 'Test' } })]);
    const eingaben: Array<Record<string, unknown>> = [];
    w.deps.fuehreAus = async (_s, input) => { eingaben.push(input); return { success: true, data: {}, display: 'ok' }; };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(eingaben.find(e => e.action === 'kopieren')?.timeout_s).toBe(10800);
  });

  it('v1723: Lese-Aktion im Change läuft streng (Exit ≠ 0 = Fehler); Abbruchmeldung nennt die echte Dauer', async () => {
    const w = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'lesen', einordnung: 'lesen', parameter: { name: 'docker-com-01', befehl: 'docker logs --since 5m livekit' } })]);
    const aufrufe: Array<boolean | undefined> = [];
    w.deps.fernLesen = async (_z, _b, _t, streng) => { aufrufe.push(streng); throw new Error('Exit 1: Cannot connect to the Docker daemon'); };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(aufrufe[0]).toBe(true);
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    const w2 = welt([S({ nr: 1, art: 'warten', zeitlimitS: 14400, pruefung: { typ: 'befehl', zugang: 'pg-repo-01', befehl: 'pg-c-state', erwartet: 'OK', abbruch: 'FEHLER' } })]);
    w2.deps.fernLesen = async () => 'FEHLER\n';
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    const fehler = JSON.stringify(w2.c.lauf);
    expect(fehler).toMatch(/Nach \d+ s abgebrochen/);
    expect(fehler).not.toMatch(/nach 14400 s/);
  });

  it('v1754: Lese-Schritt mit befehle=[…] führt jeden Befehl aus (Realfall 886c0b3b: „nie erlaubt“)', async () => {
    const w = welt([S({ nr: 1, skill: 'fernzugriff', aktion: 'lesen', einordnung: 'lesen', parameter: { name: 'pve', befehle: ['pvesm status --storage pbs-pve2', 'pvesm list pbs-pve2 --content backup --vmid 9102'] } })]);
    const gelesen: string[] = [];
    w.deps.fernLesen = async (_z, b) => { gelesen.push(b); return `ok ${b}\n`; };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(gelesen).toEqual(['pvesm status --storage pbs-pve2', 'pvesm list pbs-pve2 --content backup --vmid 9102']);
    expect((w.c.lauf as ChangeLauf).ergebnisse[0]!.ok).toBe(true);
  });

  it('v1640: nie gestarteten Change verwerfen (Entwurf); gestarteten nicht', async () => {
    const w = welt(probe(), { status: 'draft' });
    const verworfen: string[] = [];
    w.deps.itsm.verwerfen = async (_o, id) => { verworfen.push(id); w.c.status = 'cancelled' as never; return w.c; };
    const m = new ChangeMotor(w.deps);
    expect(await m.steuern('o', 'chg-1', 'abbrechen')).toContain('verworfen (war in Planung)');
    expect(verworfen).toEqual(['chg-1']);
    const w2 = welt(probe(), { snapshotFehlt: true });
    w2.deps.itsm.verwerfen = async () => { throw new Error('darf nicht'); };
    const m2 = new ChangeMotor(w2.deps);
    await m2.anstossen(); await warte(m2);
    expect(await m2.steuern('o', 'chg-1', 'abbrechen')).toContain('abgebrochen'); // gestartet → normaler Abbruch über den Motor
  });

  it('v1633: Prüf-Schritt speichert das Gelesene und belegt es im Bericht', async () => {
    const w = welt([S({ nr: 1, art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'probe-rocky-9', befehl: 'cat /etc/os-release', erwartet: 'Rocky' } })]);
    w.deps.fernLesen = async () => 'PRETTY_NAME="Rocky Linux 9.8 (Blue Onyx)"\nID="rocky"\n';
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    expect(w.c.status).toBe('completed');
    expect((w.c.lauf as ChangeLauf).ergebnisse[0]!.pruefung?.ausgabe).toContain('Rocky Linux 9.8');
    expect(w.c.result).toContain('→ PRETTY_NAME="Rocky Linux 9.8 (Blue Onyx)"');
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

  it('v1735 Realfall 94959771: Rückweg eines teilweise ausgeführten Schritts löst {{schrittN.vmid}} aus dessen Daten auf', async () => {
    const plan = probe();
    plan[1]!.rueckweg = { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: '{{schritt2.vmid}}', name: 'i3probe' } };
    const w = welt(plan);
    const orig = w.deps.fuehreAus;
    const eingaben: Array<Record<string, unknown>> = [];
    w.deps.fuehreAus = async (skill, input, t) => {
      eingaben.push(input);
      if (input.action === 'create_snapshot') { w.snaps.add('i3probe'); return { success: false, error: 'VM angelegt, Anmeldung gescheitert', data: { vmid: 9101 } }; }
      return orig(skill, input, t);
    };
    const m = new ChangeMotor(w.deps);
    await m.anstossen(); await warte(m);
    await m.steuern('o', 'chg-1', 'rueckweg'); await warte(m);
    expect(eingaben.find(e => e.action === 'delete_snapshot')).toMatchObject({ vmid: 9101, name: 'i3probe' });
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
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
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

  it('v1688 Realfall 26.10.: Owner-Frage gilt nur, solange der Change genau dort wartet; Aufräumen nach Frage und Steuerung', async () => {
    const plan: ChangeSchritt[] = [S({ nr: 1, art: 'owner', frage: 'Token eintragen' }), S({ nr: 2, art: 'pruefung', pruefung: { typ: 'ping', ziel: 'x' } })];
    const w = welt(plan);
    let aufgeraeumt = 0; w.deps.fragenAufraeumen = async () => { aufgeraeumt++; };
    await w.motor.anstossen(); await warte(w.motor);
    const p = w.fragen[0]!.p;
    expect(aufgeraeumt).toBe(1);
    expect(ownerFrageVeraltet(w.c, p)).toBe(false);
    expect(ownerFrageVeraltet(w.c, { ...p, schritt: 30 })).toBe(true);
    expect(ownerFrageVeraltet(w.c, { ...p, freigabe: 'alt' })).toBe(true);
    expect(ownerFrageVeraltet(null, p)).toBe(true);
    await w.motor.steuern('o', 'chg-1', 'abbrechen');
    expect(aufgeraeumt).toBe(2);
    expect(ownerFrageVeraltet(w.c, p)).toBe(true);
  });

  it('v1692 Realfall 5bcddc88: angehaltenen LESENDEN Schritt überspringen; ändernde/verwendete nicht', async () => {
    // Schritt 1 Snapshot (wirkt), 2 lesen → scheitert, 3 Prüfung
    const plan: ChangeSchritt[] = [
      { ...probe()[1]!, nr: 1 },
      S({ nr: 2, skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 999 }, einordnung: 'lesen' }),
      S({ nr: 3, art: 'pruefung', pruefung: { typ: 'ping', ziel: '192.168.1.96' } }),
    ];
    const w = welt(plan);
    const fuehre = w.deps.fuehreAus;
    w.deps.fuehreAus = async (skill, input, ctx) => (input.action === "vm_status" && input.vmid === 999 ? { success: false, error: "I/O error" } : fuehre(skill, input, ctx));
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
    expect(ueberspringbar(w.c.lauf as ChangeLauf, w.c)).toBe(true);
    expect(w.meldungen.some(m => m.includes('Schritt überspringen'))).toBe(true);
    expect(await w.motor.steuern('o', 'chg-1', 'ueberspringen')).toContain('Schritt 2 übersprungen');
    await warte(w.motor);
    expect(w.c.status).toBe('completed');
    const l = w.c.lauf as ChangeLauf;
    expect(l.ergebnisse.find(e => e.nr === 2)).toMatchObject({ ok: true, uebersprungen: true });
    expect(w.c.result).toContain('↷ 2.');
    expect(rueckwegSchritte(plan, l.ergebnisse).map(s => s.nr)).toEqual([1]);

    // ändernder Schritt angehalten → nicht überspringbar
    const a = welt(probe(), { snapshotFehlt: true });
    await a.motor.anstossen(); await warte(a.motor);
    expect((a.c.lauf as ChangeLauf).schritt).toBe(2);
    expect(await a.motor.steuern('o', 'chg-1', 'ueberspringen')).toContain('verändert etwas');
    // lesender Schritt, dessen Ergebnis später verwendet wird → nicht überspringbar
    const v = welt([S({ nr: 1, skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 999 }, einordnung: 'lesen' }), S({ nr: 2, skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{schritt1.vmid}}' }, einordnung: 'lesen' })]);
    v.deps.fuehreAus = async () => ({ success: false, error: 'weg' });
    await v.motor.anstossen(); await warte(v.motor);
    expect(ueberspringbar(v.c.lauf as ChangeLauf, v.c)).toBe(false);
    expect(await v.motor.steuern('o', 'chg-1', 'ueberspringen')).toContain('Schritt 2 verwendet');
  });

  it('V2: nachEnde genau einmal mit completed und dem gespeicherten Stand; Zeile steht in der Abschlussmeldung', async () => {
    const w = welt(probe());
    const aufrufe: Array<{ id: string; status: string; phase?: string; cStatus: string }> = [];
    w.deps.nachEnde = async (_o, c, status) => { aufrufe.push({ id: c.id, status, phase: (c.lauf as ChangeLauf | undefined)?.phase, cStatus: c.status }); return 'Abnahmeprotokoll erstellt: Probe (Dokument d1)'; };
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect(aufrufe).toEqual([{ id: 'chg-1', status: 'completed', phase: 'fertig', cStatus: 'completed' }]);
    const m = w.meldungen.at(-1)!;
    expect(m).toContain('✅');
    expect(m).toContain('Abnahmeprotokoll erstellt: Probe (Dokument d1)');
  });

  it('V2: wirft nachEnde, bleibt der Change completed und die Meldung nennt „Abnahmeprotokoll nicht erstellt“', async () => {
    const w = welt(probe());
    let n = 0;
    w.deps.nachEnde = async () => { n++; throw new Error('PDF kaputt'); };
    await w.motor.anstossen(); await warte(w.motor);
    expect(n).toBe(1);
    expect(w.c.status).toBe('completed');
    expect(w.meldungen.at(-1)).toContain('✅');
    expect(w.meldungen.at(-1)).toContain('Abnahmeprotokoll nicht erstellt: PDF kaputt');
  });

  it('V2: langsamer Hook → Abschlussmeldung nach der Zeitgrenze, das Protokoll folgt als eigene Meldung; ereignis vor dem Hook', async () => {
    const w = welt(probe());
    const reihenfolge: string[] = [];
    let fertig!: (z: string) => void;
    w.deps.ereignis = async (_o, _c, z) => { reihenfolge.push(`ereignis:${z}`); };
    w.deps.nachEnde = () => { reihenfolge.push('nachEnde'); return new Promise<string>(r => { fertig = r; }); };
    w.deps.nachEndeZeitMs = 10;
    const t0 = Date.now();
    await w.motor.anstossen();
    // warte() sieht den Lauf erst nach dem Start; die Zeitgrenze läuft echt (10 ms)
    for (let i = 0; i < 200 && !w.meldungen.some(m => m.startsWith('✅')); i++) await new Promise(r => setTimeout(r, 5));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(w.c.status).toBe('completed');
    expect(reihenfolge).toEqual(['ereignis:start', 'ereignis:ende', 'nachEnde']);
    const abschluss = w.meldungen.at(-1)!;
    expect(abschluss).toContain('✅');
    expect(abschluss).toContain('Abnahmeprotokoll folgt in einer eigenen Meldung (Erzeugung dauert länger als 0 s)');
    const vorher = w.meldungen.length;
    fertig('Abnahmeprotokoll erstellt: Probe — Version 1, Dokument d1');
    await new Promise(r => setTimeout(r, 5));
    expect(w.meldungen).toHaveLength(vorher + 1);
    expect(w.meldungen.at(-1)).toBe('📄 Probe (chg-1): Abnahmeprotokoll erstellt: Probe — Version 1, Dokument d1');
  });

  it('V2: Anhänge des Hooks (PDF/DOCX) gehen mit der Abschlussmeldung bzw. der Folgemeldung an den Owner', async () => {
    const w = welt(probe());
    const mitAnhang: Array<{ text: string; dateien: string[] }> = [];
    w.deps.melde = async (t, _d, anhaenge) => { w.meldungen.push(t); if (anhaenge?.length) mitAnhang.push({ text: t, dateien: anhaenge.map(a => a.fileName) }); };
    const pdf = { fileName: 'abnahme-chg-1-v1.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-') };
    w.deps.nachEnde = async () => ({ zeile: 'Abnahmeprotokoll erstellt: Probe', anhaenge: [pdf] });
    await w.motor.anstossen(); await warte(w.motor);
    expect(mitAnhang).toHaveLength(1);
    expect(mitAnhang[0]!.text).toContain('✅');
    expect(mitAnhang[0]!.text).toContain('Abnahmeprotokoll erstellt: Probe');
    expect(mitAnhang[0]!.dateien).toEqual(['abnahme-chg-1-v1.pdf']);
    // nach der Zeitgrenze: Anhänge an der Folgemeldung, nicht an der Abschlussmeldung
    const w2 = welt(probe());
    const mit2: Array<{ text: string; dateien: string[] }> = [];
    w2.deps.melde = async (t, _d, anhaenge) => { w2.meldungen.push(t); mit2.push({ text: t, dateien: (anhaenge ?? []).map(a => a.fileName) }); };
    let fertig!: (z: { zeile: string; anhaenge: typeof pdf[] }) => void;
    w2.deps.nachEnde = () => new Promise(r => { fertig = r; });
    w2.deps.nachEndeZeitMs = 10;
    await w2.motor.anstossen();
    for (let i = 0; i < 200 && !w2.meldungen.some(m => m.startsWith('✅')); i++) await new Promise(r => setTimeout(r, 5));
    expect(mit2.find(m => m.text.startsWith('✅'))!.dateien).toEqual([]);
    fertig({ zeile: 'Abnahmeprotokoll erstellt: spät', anhaenge: [pdf] });
    await new Promise(r => setTimeout(r, 5));
    expect(mit2.at(-1)).toEqual({ text: '📄 Probe (chg-1): Abnahmeprotokoll erstellt: spät', dateien: ['abnahme-chg-1-v1.pdf'] });
  });

  it('V2: langsamer Hook, der später scheitert → Folgemeldung „nicht erstellt“', async () => {
    const w = welt(probe());
    let scheitere!: (e: Error) => void;
    w.deps.nachEnde = () => new Promise<string>((_r, f) => { scheitere = f; });
    w.deps.nachEndeZeitMs = 10;
    await w.motor.anstossen();
    for (let i = 0; i < 200 && !w.meldungen.some(m => m.startsWith('✅')); i++) await new Promise(r => setTimeout(r, 5));
    scheitere(new Error('pve2 hängt'));
    await new Promise(r => setTimeout(r, 5));
    expect(w.meldungen.at(-1)).toBe('📄 Probe (chg-1): Abnahmeprotokoll nicht erstellt: pve2 hängt');
  });

  it('V2: nachEnde auch bei Rückweg/Abbruch mit dem jeweiligen Status', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    const st: string[] = [];
    w.deps.nachEnde = async (_o, _c, s) => { st.push(s); return undefined; };
    await w.motor.anstossen(); await warte(w.motor);
    expect(st).toEqual([]); // angehalten ist kein Ende
    await w.motor.steuern('o', 'chg-1', 'rueckweg'); await warte(w.motor);
    expect(st).toEqual(['rolled_back']);
    expect(w.meldungen.at(-1)).not.toContain('Abnahmeprotokoll');
  });

  it('S1: Halt und Rückweg melden sich an nachStoerung (Sperre der Standard-Vorlage)', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    const gemeldet: string[] = [];
    w.deps.nachStoerung = async (_o, c, grund) => { gemeldet.push(`${c.id} ${grund}`); };
    await w.motor.anstossen(); await warte(w.motor);
    expect(gemeldet).toHaveLength(1);
    expect(gemeldet[0]).toMatch(/^chg-1 angehalten: Schritt 2/);
    await w.motor.steuern('o', 'chg-1', 'rueckweg'); await warte(w.motor);
    expect(w.c.status).toBe('rolled_back');
    expect(gemeldet.at(-1)).toMatch(/^chg-1 zurückgerollt/);
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
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
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
  it('v1690 Realfall a3982e74: Proxmox-Task-ID mit Token-Benutzer ist zulässig, „!“ sonst nicht', () => {
    const upid = 'UPID:pve3:002C85BD:074F24AE:6AE09306:qmrestore:9150:root@pam!alfred-ai:';
    const erg = [{ nr: 3, ok: true, start: 'x', daten: { upid, falsch: 'UPID:pve3:1:2:3:x:1:root@pam!a$(id):', knall: 'a!b' } }];
    expect(loeseAuf({ befehl: `pvesh get /nodes/pve3/tasks/{{schritt3.upid}}/status` }, erg).wert).toEqual({ befehl: `pvesh get /nodes/pve3/tasks/${upid}/status` });
    expect(loeseAuf({ befehl: 'echo {{schritt3.falsch}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ befehl: 'echo {{schritt3.knall}}' }, erg).fehler).toContain('unzulässigen Wert');
  });
});

describe('I4 Sicherheitsbefund: Freigabe vor jedem Schritt', () => {
  it('geänderter Fingerabdruck nach Neustart → anhalten, nichts ausführen', async () => {
    const w = welt(probe(), { status: 'in_progress' });
    w.c.lauf = { phase: 'laeuft', schritt: 1, start: new Date().toISOString(), ergebnisse: [] } satisfies ChangeLauf;
    w.c.fingerabdruck = 'anders';
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase, `${w.c.status} ${w.c.result} ${w.meldungen.join(' | ')}`).toBe('angehalten');
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

// v1682 — Realfall 26.10. (Matrix J c89f6bd9): Abbrechen, während ein Owner-Schritt wartet
describe('v1682 Steuern bei wartendem Owner-Schritt', () => {
  it('abbrechen beendet den Change, die alte Owner-Frage wirkt danach nicht mehr', async () => {
    const plan: ChangeSchritt[] = [S({ nr: 1, art: 'owner', frage: 'Token im Tresor?' }), S({ nr: 2, art: 'pruefung', pruefung: { typ: 'ping', ziel: 'x' } })];
    const w = welt(plan);
    await w.motor.anstossen(); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).phase).toBe('wartet_owner');
    expect(await w.motor.steuern('o', 'chg-1', 'abbrechen')).toContain('abgebrochen');
    expect(w.c.status).toBe('cancelled');
    expect(await w.motor.ownerSchrittErledigt('o', 'chg-1', 1, w.fragen[0]!.p.freigabe)).not.toContain('läuft weiter');
  });
});

// v1683 — Realfall 26.10. (Matrix J Schritt 5): lokaler Resolver mit Altantwort, öffentliche Resolver kennen den neuen Eintrag
describe('v1683 DNS-Prüfung ohne lokalen Cache', () => {
  it('besteht, wenn öffentliche Resolver den erwarteten Wert liefern', async () => {
    const plan: ChangeSchritt[] = [S({ nr: 1, art: 'pruefung', pruefung: { typ: 'dns', ziel: 'turn.3033.at', erwartet: '91.114.43.173' } })];
    const w = welt(plan);
    w.deps.netz.dns = async () => ['185.51.8.94'];
    (w.deps.netz as { dnsFrisch?: (n: string) => Promise<string[]> }).dnsFrisch = async () => ['91.114.43.173'];
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).toBe('completed');
  });
  it('scheitert weiter, wenn auch öffentlich der alte Wert steht', async () => {
    const plan: ChangeSchritt[] = [S({ nr: 1, art: 'pruefung', zeitlimitS: 1, pruefung: { typ: 'dns', ziel: 'turn.3033.at', erwartet: '91.114.43.173' } })];
    const w = welt(plan);
    w.deps.netz.dns = async () => ['185.51.8.94'];
    (w.deps.netz as { dnsFrisch?: (n: string) => Promise<string[]> }).dnsFrisch = async () => ['185.51.8.94'];
    await w.motor.anstossen(); await warte(w.motor);
    expect(w.c.status).not.toBe('completed');
  });
});

describe('v1830 Base64-Verweis nur im Feld base64', () => {
  it('striktes Base64 als ganzer Wert im Feld base64 erlaubt, sonst nicht', async () => {
    const { loeseAuf } = await import('./change-lauf.js');
    const erg = [{ nr: 25, ok: true, daten: { zertifikat: { base64: 'MIIB+w==', sha256: 'ab12' }, boese: 'a;b' } }] as never;
    expect(loeseAuf({ base64: '{{schritt25.zertifikat.base64}}' }, erg)).toEqual({ wert: { base64: 'MIIB+w==' } });
    expect(loeseAuf({ datei: '{{schritt25.zertifikat.base64}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ base64: 'x{{schritt25.zertifikat.base64}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ base64: '{{schritt25.boese}}' }, erg).fehler).toContain('unzulässigen Wert');
  });
});

describe('v1833 Base64-Felder mit Präfix', () => {
  it('csr_base64 & Co. nehmen striktes Base64 als ganzen Wert an, andere Felder nicht', async () => {
    const { loeseAuf } = await import('./change-lauf.js');
    const erg = [{ nr: 32, ok: true, daten: { csrBase64: 'MIIB+w==' } }] as never;
    for (const f of ['csr_base64', 'crl_base64', 'root_base64', 'zert_base64', 'sub_base64']) expect(loeseAuf({ [f]: '{{schritt32.csrBase64}}' }, erg).fehler).toBeUndefined();
    expect(loeseAuf({ befehl_base64x: '{{schritt32.csrBase64}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ name: '{{schritt32.csrBase64}}' }, erg).fehler).toContain('unzulässigen Wert');
  });
});

// v1843 — Realfall 13.11. 2ee9634f Schritt 2: beobachtende Skill-Prüfung lief mit festen 60 s ins Zeitlimit
describe('v1843 Zeitgrenze beobachtender Skill-Prüfungen', () => {
  it('dauer_s bestimmt die Grenze, sonst 60 s', async () => {
    const w = welt([]);
    const grenzen: number[] = [];
    w.deps.fuehreAus = async (_s, _i, t) => { grenzen.push(t); return { success: true, display: 'CLUSTER_STABLE' }; };
    const m = new ChangeMotor(w.deps);
    await m.pruefe({ typ: 'skill', skill: 'windows_cluster', aktion: 'stabilitaet_pruefen', parameter: { zugaenge: ['sql01'], dauer_s: 300 }, erwartet: 'CLUSTER_STABLE' });
    await m.pruefe({ typ: 'skill', skill: 'windows_cluster', aktion: 'status', parameter: { zugang: 'fs01' } });
    await m.pruefe({ typ: 'skill', skill: 'x', aktion: 'y', parameter: { dauer_s: 99999 } });
    expect(grenzen).toEqual([600_000, 60_000, 2_400_000]);
  });
});

// v1844 — Rückweg publication_setzen mit cdp_roh/aia_roh aus dem gemeldeten „vorher“
describe('v1844 Listen-Verweis in <name>_roh', () => {
  it('Liste im CA-Format als ganzer Wert in cdp_roh/aia_roh erlaubt, sonst nicht', async () => {
    const { loeseAuf } = await import('./change-lauf.js');
    // Realwerte aus PKI-A Schritt 14 und PKI-B Schritt 44 (inkl. %windir% und versteckter Freigabe pki$)
    const cdp = ['1:%windir%\\system32\\CertSrv\\CertEnroll\\ad3033-root%8%9.crl', '2:http://pki.ad.3033.at/pki/ad3033-issuing1%8%9.crl', '1:file://\\\\fs01.ad.3033.at\\pki$\\ad3033-issuing1%8%9.crl'];
    const aia = ['1:C:\\Windows\\System32\\CertSrv\\CertEnroll\\ad3033-issuing1%4.crt', '1:file://\\\\fs01.ad.3033.at\\pki$\\ad3033-issuing1%4.crt'];
    const erg = [{ nr: 14, ok: true, daten: { vorher: { cdp, aia, leer: [], boese: ['1:C:/x"; rm -rf /'], ps: ['1:C:\\$(Get-Process)\\x.crl'], ps2: ['1:${env:windir}\\x.crl'], zahl: [1] } } }] as never;
    const r = loeseAuf({ vmid: 154, cdp_roh: '{{schritt14.vorher.cdp}}', aia_roh: '{{schritt14.vorher.aia}}' }, erg);
    expect(r.fehler).toBeUndefined();
    expect(r.wert).toEqual({ vmid: 154, cdp_roh: cdp, aia_roh: aia });
    expect(loeseAuf({ ziel: '{{schritt14.vorher.cdp}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: '{{schritt14.vorher.boese}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: '{{schritt14.vorher.leer}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: '{{schritt14.vorher.ps}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: '{{schritt14.vorher.ps2}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: '{{schritt14.vorher.zahl}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ cdp_roh: 'x{{schritt14.vorher.cdp}}' }, erg).fehler).toBeTruthy();
  });
});

describe('Dokument-Vorlagen: Verlauf im Lauf', () => {
  it('Halt schreibt genau einen Eintrag „halt“; wiederholen hängt an, der Halt bleibt', async () => {
    const w = welt(probe(), { snapshotFehlt: true });
    await w.motor.anstossen(); await warte(w.motor);
    const l = w.c.lauf as ChangeLauf;
    expect(l.phase).toBe('angehalten');
    expect(l.verlauf).toHaveLength(1);
    expect(l.verlauf![0]).toMatchObject({ art: 'halt', schritt: 2 });
    expect(l.verlauf![0]!.text.length).toBeLessThanOrEqual(300);
    w.snaps.add('i3probe');
    await w.motor.steuern('o', 'chg-1', 'wiederholen'); await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect((w.c.lauf as ChangeLauf).verlauf!.map(e => [e.art, e.schritt])).toEqual([['halt', 2], ['wiederholen', 2]]);
  });

  it('überspringen und freigegebene Plan-Korrektur landen im Verlauf', async () => {
    const plan: ChangeSchritt[] = [
      { ...probe()[1]!, nr: 1 },
      S({ nr: 2, skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 999 }, einordnung: 'lesen' }),
    ];
    const w = welt(plan);
    const fuehre = w.deps.fuehreAus;
    w.deps.fuehreAus = async (skill, input, ctx) => (input.action === 'vm_status' && input.vmid === 999 ? { success: false, error: 'I/O error' } : fuehre(skill, input, ctx));
    await w.motor.anstossen(); await warte(w.motor);
    await w.motor.steuern('o', 'chg-1', 'ueberspringen'); await warte(w.motor);
    expect((w.c.lauf as ChangeLauf).verlauf!.map(e => e.art)).toEqual(['halt', 'ueberspringen']);

    const k = welt(probe(), { snapshotFehlt: true });
    await k.motor.anstossen(); await warte(k.motor);
    const l = k.c.lauf as ChangeLauf;
    l.korrektur = { abSchritt: l.schritt, zeit: '2026-11-15T08:00:00.000Z' };
    Object.assign(k.c, { fingerabdruck: 'neu', freigabeFingerabdruck: 'alt' });
    await k.motor.steuern('o', 'chg-1', 'wiederholen'); // ohne Freigabe: kein Eintrag gespeichert
    expect(((k.c.lauf as ChangeLauf).verlauf ?? []).map(e => e.art)).toEqual(['halt']);
    k.c.freigabeFingerabdruck = 'neu'; k.snaps.add('i3probe');
    await k.motor.anstossen(); await warte(k.motor);
    expect(k.c.status).toBe('completed');
    const v = (k.c.lauf as ChangeLauf).verlauf!;
    expect(v.map(e => e.art)).toEqual(['halt', 'plan_geaendert', 'wiederholen']);
    expect(v[1]).toMatchObject({ zeit: '2026-11-15T08:00:00.000Z', schritt: 2 });
    expect(v[2]!.text).toContain('nach Freigabe der Korrektur fortgesetzt');
  });

  it('merkeVerlauf schwärzt vor dem Kürzen', () => {
    const l = { phase: 'angehalten', schritt: 1, start: 'x', ergebnisse: [] } as ChangeLauf;
    merkeVerlauf(l, { zeit: 'z', art: 'halt', schritt: 1, text: 'a'.repeat(280) + '\npassword=Geheim123!' });
    expect(l.verlauf![0]!.text).not.toContain('Geheim');
    expect(l.verlauf![0]!.text.length).toBeLessThanOrEqual(300);
  });

  it('merkeVerlauf kappt bei 200: die ersten 50, Platzhalter mit richtiger Zahl, die neuesten', () => {
    const l = { phase: 'laeuft', schritt: 1, start: 'x', ergebnisse: [] } as ChangeLauf;
    for (let i = 1; i <= 250; i++) merkeVerlauf(l, { zeit: `z${i}`, art: 'wiederholen', schritt: 1, text: `E${i}` });
    expect(l.verlauf).toHaveLength(200);
    expect(l.verlauf![49]!.text).toBe('E50');
    expect(l.verlauf![50]).toMatchObject({ art: 'ausgelassen', anzahl: 51, text: '… 51 Einträge ausgelassen' });
    expect(l.verlauf![51]!.text).toBe('E102');
    expect(l.verlauf![199]!.text).toBe('E250');
    merkeVerlauf(l, { zeit: 'z251', art: 'halt', schritt: 1, text: 'E251' });
    expect(l.verlauf).toHaveLength(200);
    expect(l.verlauf![50]).toMatchObject({ art: 'ausgelassen', anzahl: 52 });
    expect(l.verlauf![51]!.text).toBe('E103');
    expect(l.verlauf![199]!.text).toBe('E251');
  });
});

// V3 Task 3 — Verweis über Change-Grenzen zur Laufzeit
describe('V3 Verweis über Change-Grenzen', () => {
  const VOR = 'chg-vor-0000-0000-000000000001';
  const erg = [{ nr: 2, ok: true, start: 'x', daten: { policy_id: 'pol-42', vmid: 142, frei: 'a b', liste: ['x'], base64: 'QUJD' } }];
  it('loeseAuf: aus vorgaenger aufgelöst (Typ bleibt), fehlender Vorgänger → Fehler mit Grund, unsichere Werte und ganzer Befehl abgewiesen', () => {
    const vg = new Map([[VOR, erg]]);
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.policy_id}}`, vmid: `{{ change:${VOR}.schritt2.vmid }}`, url: `http://h/{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, vg))
      .toEqual({ wert: { id: 'pol-42', vmid: 142, url: 'http://h/pol-42' } });
    const fehlt = loeseAuf({ id: `{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, new Map());
    expect(fehlt.fehler).toBe(`Verweis auf Change ${VOR.slice(0, 8)}: nicht abgeschlossen oder keine Abhängigkeit`);
    expect(fehlt.wert).toEqual({ id: '' });
    expect(loeseAuf({ id: `x{{change:${VOR}.schritt2.policy_id}}` }, [], undefined).fehler).toContain('nicht abgeschlossen oder keine Abhängigkeit');
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.frei}}` }, [], undefined, vg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ id: `p-{{change:${VOR}.schritt2.frei}}` }, [], undefined, vg).fehler).toContain('unzulässigen Wert');
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.gibtsnicht}}` }, [], undefined, vg).fehler).toContain('hat keinen Wert');
    expect(loeseAuf({ id: `{{change:${VOR}.schritt3.policy_id}}` }, [], undefined, vg).fehler).toContain('hat keinen Wert');
    for (const feld of ['befehl', 'Command', 'cmd', 'SCRIPT', 'skript']) expect(loeseAuf({ [feld]: `{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, vg).fehler).toContain('ganzer Befehl');
    // Ganzwert-Ausnahmen wie bei {{schrittN.feld}}
    expect(loeseAuf({ base64: `{{change:${VOR}.schritt2.base64}}` }, [], undefined, vg).wert).toEqual({ base64: 'QUJD' });
    // nur Ergebnisse, die etwas bewirkt haben
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, new Map([[VOR, [{ ...erg[0]!, ok: false }]]])).fehler).toContain('hat keinen Wert');
  });

  function zweiChanges(vorStatus: string, policy: unknown = `{{change:${VOR}.schritt2.policy_id}}`) {
    const schritte = [
      S({ nr: 1, skill: 'unifi', aktion: 'delete_policy', parameter: { policy_id: policy }, einordnung: 'aendern', rueckweg: { keiner: 'Test' } }),
    ];
    const w = welt(schritte);
    w.c.abhaengigVon = [VOR];
    // C-1 — beim Planen festgehaltener Abdruck des Vorgängers
    w.c.pruefung = { fehler: [], hinweise: [], zeit: 'x', zusatz: { vorgaengerAbdruck: { [VOR]: 'fp-vor' } } } as never;
    const vor: CmdbChangeRequest = { id: VOR, userId: 'o', title: 'Vorgänger', type: 'normal', status: vorStatus as never, riskLevel: 'low', affectedAssetIds: ['a-x'], affectedServiceIds: [], schritte: [S({ nr: 2, skill: 'unifi', aktion: 'create_policy' })], lauf: { phase: 'fertig', schritt: 2, start: 'x', ergebnisse: erg }, fingerabdruck: 'fp-vor', freigabeFingerabdruck: 'fp-vor', createdAt: 'x', updatedAt: 'x' };
    const eingaben: Array<Record<string, unknown>> = [];
    w.deps.itsm.liste = async () => [w.c, vor];
    w.deps.itsm.hole = async (_o, id) => (id === VOR ? vor : id === w.c.id ? w.c : null);
    const fa = w.deps.fuehreAus;
    w.deps.fuehreAus = async (skill, input, t) => { eingaben.push(input); return fa(skill, input, t); };
    return { ...w, motor: new ChangeMotor(w.deps), eingaben, vor };
  }
  it('Motor: Vorgänger completed → Wert eingesetzt', async () => {
    const w = zweiChanges('completed');
    expect(await w.motor.anstossen()).toEqual(['chg-1']);
    await warte(w.motor);
    expect(w.c.status).toBe('completed');
    expect(w.eingaben).toContainEqual(expect.objectContaining({ action: 'delete_policy', policy_id: 'pol-42' }));
  });
  it('Motor: Vorgänger failed → Schritt hält mit Grund an, kein Skill bekommt den Platzhaltertext', async () => {
    const w = zweiChanges('failed');
    // anstossen startet ihn nicht (Abhängigkeit nicht abgeschlossen) — direkt weiter (z. B. Wiederaufnahme nach Statuswechsel)
    expect(await w.motor.anstossen()).toEqual([]);
    w.c.status = 'in_progress' as never;
    await w.motor.weiter('o', w.c, { phase: 'laeuft', schritt: 1, start: 'x', ergebnisse: [] });
    const l = w.c.lauf as ChangeLauf;
    expect(l.phase).toBe('angehalten');
    expect(l.grund).toContain(`Verweis auf Change ${VOR.slice(0, 8)}: nicht abgeschlossen oder keine Abhängigkeit`);
    expect(w.eingaben).toEqual([]);
    expect(JSON.stringify(w.eingaben)).not.toContain('{{');
  });
  it('Motor: Vorgänger completed, aber nicht in abhaengigVon → hält an', async () => {
    const w = zweiChanges('completed');
    w.c.abhaengigVon = [];
    expect(await w.motor.anstossen()).toEqual([]);
    w.c.status = 'in_progress' as never; await w.motor.weiter('o', w.c, { phase: 'laeuft', schritt: 1, start: 'x', ergebnisse: [] });
    expect((w.c.lauf as ChangeLauf).phase).toBe('angehalten');
    expect((w.c.lauf as ChangeLauf).grund).toContain('nicht abgeschlossen oder keine Abhängigkeit');
    expect(w.eingaben).toEqual([]);
  });

  // Laufzeit-Halt als zweite Sicherung: direkt weiter (anstossen startet solche Changes seit Fix-Runde 2 gar nicht erst)
  const direkt = async (w: ReturnType<typeof zweiChanges>) => { w.c.status = 'in_progress' as never; await w.motor.weiter('o', w.c, { phase: 'laeuft', schritt: 1, start: 'x', ergebnisse: [] }); };
  const haltGrund = async (w: ReturnType<typeof zweiChanges>) => {
    await direkt(w);
    const l = w.c.lauf as ChangeLauf;
    expect(l.phase).toBe('angehalten');
    expect(w.eingaben).toEqual([]);
    return l.grund ?? '';
  };
  it('C-1: Vorgänger nach der Planung geändert (anderer Abdruck) → Schritt hält an', async () => {
    const w = zweiChanges('completed');
    w.vor.fingerabdruck = 'fp-neu'; w.vor.freigabeFingerabdruck = 'fp-neu';
    expect(await haltGrund(w)).toContain(`Verweis auf Change ${VOR.slice(0, 8)}: Vorgänger nach der Planung geändert — abhängigen Change neu planen`);
    const w2 = zweiChanges('completed');
    w2.c.pruefung = { fehler: [], hinweise: [], zeit: 'x' } as never; // kein festgehaltener Abdruck
    expect(await haltGrund(w2)).toContain('Vorgänger nach der Planung geändert');
  });
  it('I-1: completed, aber Rückweg begonnen oder nicht fertig → hält an', async () => {
    for (const lauf of [{ phase: 'rueckweg' }, { phase: 'angehalten' }, { phase: 'fertig', rueckweg: [{ zuSchritt: 2, ok: true, text: 'x', zeit: 'x' }] }]) {
      const w = zweiChanges('completed');
      w.vor.lauf = { schritt: 2, start: 'x', ergebnisse: erg, ...lauf };
      expect(await haltGrund(w), JSON.stringify(lauf)).toContain('nicht abgeschlossen oder keine Abhängigkeit');
    }
  });
  it('M-1: über Change-Grenzen nur Ergebnisse mit ok', () => {
    const vg = new Map([[VOR, [{ ...erg[0]!, ok: false, aktionOk: true }]]]);
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, vg).fehler).toContain('hat keinen Wert');
    expect(loeseAuf({ id: `{{change:${VOR}.schritt2.policy_id}}` }, [], undefined, new Map([[VOR, [{ ...erg[0]!, ok: false, teilweise: true }]]])).fehler).toContain('hat keinen Wert');
  });
  it('I-2: unaufgelöster oder kaputter Verweis erreicht nie einen Skill', async () => {
    for (const v of [`{{Change:${VOR}.schritt2.policy_id}}`, `{{change:${VOR}.schritt2.a b}}`, `{{change:${VOR}.schritt2.policy_id }x}}`, '{{Schritt2.policy_id}}']) {
      expect(await haltGrund(zweiChanges('completed', v)), v).toContain('unaufgelöster Verweis');
    }
  });

  it('N-1: Change mit geändertem Vorgänger startet nicht (kein Schritt läuft), Meldung einmal', async () => {
    const w = zweiChanges('completed');
    // Schritt 1 wirkt, erst Schritt 2 verweist auf den Vorgänger
    w.c.schritte = [
      S({ nr: 1, skill: 'unifi', aktion: 'create_rule', parameter: { name: 'r1' }, einordnung: 'aendern', rueckweg: { keiner: 'Test' } }),
      S({ nr: 2, skill: 'unifi', aktion: 'delete_policy', parameter: { policy_id: `{{change:${VOR}.schritt2.policy_id}}` }, einordnung: 'aendern', rueckweg: { keiner: 'Test' } }),
    ];
    w.vor.fingerabdruck = 'fp-neu'; w.vor.freigabeFingerabdruck = 'fp-neu';
    expect(await w.motor.anstossen()).toEqual([]);
    expect(await w.motor.anstossen()).toEqual([]);
    await warte(w.motor);
    expect(w.eingaben).toEqual([]);
    expect(w.c.status).toBe('approved');
    const m = w.meldungen.filter(x => x.includes('wartet'));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain(`Vorgänger ${VOR.slice(0, 8)} nach der Planung geändert`);
    // Vorgänger nicht fertig (Rückweg) → ebenso nicht starten
    const w2 = zweiChanges('completed');
    w2.vor.lauf = { phase: 'rueckweg', schritt: 2, start: 'x', ergebnisse: erg };
    expect(await w2.motor.anstossen()).toEqual([]);
    expect(w2.eingaben).toEqual([]);
    expect(w2.meldungen.filter(x => x.includes('wartet'))).toHaveLength(1);
  });
  // Final-Welle I1 — Realfall-Szenario pki_lab: Vorgänger fertig, aber der referenzierte Schritt lieferte keinen Wert (gescheitert, vom
  // Owner übersprungen) → der abhängige Change startet gar nicht (sonst liefen Lösch-Schritte davor = halber Abbau)
  const halberAbbau = (vorErg: unknown[], ref: Record<string, unknown> = { parameter: { policy_id: `{{change:${VOR}.schritt2.policy_id}}` } }) => {
    const w = zweiChanges('completed');
    w.c.schritte = [
      S({ nr: 1, skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 157 }, einordnung: 'loeschen', rueckweg: { keiner: 'Test' } }),
      S({ nr: 2, skill: 'unifi', aktion: 'delete_policy', einordnung: 'aendern', rueckweg: { keiner: 'Test' }, ...ref }),
    ];
    w.vor.lauf = { phase: 'fertig', schritt: 2, start: 'x', ergebnisse: vorErg as never };
    return w;
  };
  it('I1: referenzierter Vorgänger-Schritt gescheitert → startet nicht, kein Schritt läuft, Meldung nennt Wert, Change und Schritt', async () => {
    const w = halberAbbau([{ nr: 2, ok: false, start: 'x', fehler: 'success:false' }]);
    expect(await w.motor.anstossen()).toEqual([]);
    expect(await w.motor.anstossen()).toEqual([]);
    await warte(w.motor);
    expect(w.eingaben).toEqual([]);
    expect(w.c.status).toBe('approved');
    const m = w.meldungen.filter(x => x.includes('⏸️'));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain(`Wert policy_id aus Change ${VOR.slice(0, 8)} Schritt 2 fehlt`);
    // N-5 — neu geplant (anderer Fingerabdruck) → wieder gemeldet
    w.c.fingerabdruck = 'fp-neu-geplant';
    expect(await w.motor.anstossen()).toEqual([]);
    expect(w.meldungen.filter(x => x.includes('⏸️'))).toHaveLength(2);
  });
  it('I1: übersprungener Schritt, fehlendes Feld, unsicherer Wert, Verweis nur im Rückweg oder in der Prüfung → startet nicht', async () => {
    const fall: Array<[unknown[], Record<string, unknown> | undefined, string]> = [
      [[{ nr: 2, ok: true, uebersprungen: true, start: 'x', ausgabe: 'vom Owner übersprungen' }], undefined, 'Schritt 2 fehlt'],
      [[{ nr: 2, ok: true, start: 'x', daten: { anders: 1 } }], undefined, 'Schritt 2 fehlt'],
      [[{ nr: 2, ok: true, start: 'x', daten: { policy_id: 'a b' } }], undefined, 'Schritt 2 ist unzulässig'],
      [[{ nr: 2, ok: false, start: 'x' }], { parameter: { x: 1 }, rueckweg: { skill: 'unifi', aktion: 'create_policy', parameter: { id: `{{change:${VOR}.schritt2.policy_id}}` } } }, 'Schritt 2 fehlt'],
      [[{ nr: 2, ok: false, start: 'x' }], { parameter: { x: 1 }, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_policies', erwartet: `{{change:${VOR}.schritt2.policy_id}}` } }, 'Schritt 2 fehlt'],
    ];
    for (const [erg2, ref, erwartet] of fall) {
      const w = halberAbbau(erg2, ref);
      expect(await w.motor.anstossen(), erwartet).toEqual([]);
      expect(w.eingaben).toEqual([]);
      expect(w.meldungen.join('\n')).toContain(erwartet);
    }
    // Gegenprobe: Wert vorhanden und sicher → startet
    const ok = halberAbbau([{ nr: 2, ok: true, start: 'x', daten: { policy_id: 'pol-42' } }]);
    expect(await ok.motor.anstossen()).toEqual(['chg-1']);
  });
  it('N-6: Meldung je Grund — geändert / zurückgenommen / nicht fertig', async () => {
    const g = zweiChanges('completed');
    g.vor.fingerabdruck = 'fp-neu'; g.vor.freigabeFingerabdruck = 'fp-neu';
    await g.motor.anstossen();
    expect(g.meldungen.join('\n')).toContain('neu planen (change_aendern) und neu freigeben');
    const r = zweiChanges('completed');
    r.vor.lauf = { phase: 'fertig', schritt: 2, start: 'x', ergebnisse: erg, rueckweg: [{ zuSchritt: 2, ok: true, text: 'x', zeit: 'x' }] };
    await r.motor.anstossen();
    expect(r.meldungen.join('\n')).toContain(`Vorgänger ${VOR.slice(0, 8)} zurückgenommen`);
    expect(r.meldungen.join('\n')).not.toContain('change_aendern');
    const n = zweiChanges('completed');
    n.vor.lauf = { phase: 'angehalten', schritt: 2, start: 'x', ergebnisse: erg };
    await n.motor.anstossen();
    expect(n.meldungen.join('\n')).toContain(`wartet, bis Vorgänger ${VOR.slice(0, 8)} fertig ist`);
    expect(n.meldungen.join('\n')).not.toContain('change_aendern');
  });
  it('N-4: Wächter-Meldung nennt nur den Anfang des Verweises, keine Werte', () => {
    const t = unaufgeloesterVerweis({ x: '{{Change:abcdef.schritt2.policy_id geheimwert12345}}' })!;
    expect(t).toContain('{{Change:abcdef');
    expect(t).not.toContain('geheimwert');
  });
});

describe('Ruling R16 — kuerzeDaten behält strikte Base64-Felder (…Base64) unverkürzt', () => {
  const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');
  it('unter der Grenze unverändert; darüber nur die übrigen Felder flach/gekürzt, Base64-Felder vollständig', () => {
    const klein = { zustand: 'ok', zertBase64: b64(300) };
    expect(kuerzeDaten(klein)).toBe(klein);
    const gross = { zustand: 'ausgestellt', thumbprint: 'AB'.repeat(20), sans: ['a', 'b'], zertifikatPem: 'P'.repeat(7000), zertBase64: b64(2000), issuingBase64: b64(1600), rootBase64: b64(1300) };
    const k = kuerzeDaten(gross) as Record<string, unknown>;
    expect(k.zertBase64).toBe(gross.zertBase64);
    expect(k.issuingBase64).toBe(gross.issuingBase64);
    expect(k.rootBase64).toBe(gross.rootBase64);
    expect(k.zertifikatPem).toBe('P'.repeat(300));
    expect(k.thumbprint).toBe(gross.thumbprint);
    expect(k.sans).toBeUndefined();
    // die Base64-Felder zählen nicht zur Obergrenze: übriger Teil klein → alles unverändert
    const nurB64 = { zustand: 'ausgestellt', zertBase64: b64(3000), issuingBase64: b64(3000), rootBase64: b64(3000) };
    expect(JSON.stringify(nurB64).length).toBeGreaterThan(MAX_DATEN);
    expect(kuerzeDaten(nurB64)).toBe(nurB64);
  });
  it('nur striktes Base64, nur Schlüssel auf „Base64“, höchstens BASE64_DATEN_MAX — sonst wie bisher gekürzt', () => {
    const zuLang = b64(BASE64_DATEN_MAX);
    expect(zuLang.length).toBeGreaterThan(BASE64_DATEN_MAX);
    const f = kuerzeDaten({ zertBase64: zuLang, keinB64Base64: 'mit leer zeichen '.repeat(500), zert_b64: b64(9000) }) as Record<string, string>;
    expect(f.zertBase64).toHaveLength(300);
    expect(f.keinB64Base64).toHaveLength(300);
    expect(f.zert_b64).toHaveLength(300);
  });
  it('Fix-Runde 2: zusammen höchstens BASE64_DATEN_SUMME Zeichen — weitere Base64-Felder werden wie der Rest gekürzt', () => {
    const feld = b64(12_000); // 16000 Zeichen je Feld
    const d: Record<string, string> = { aBase64: feld, bBase64: feld, cBase64: feld, dBase64: feld, eBase64: feld, fBase64: feld };
    const k = kuerzeDaten(d) as Record<string, string>;
    const voll = Object.values(k).filter(v => v.length === feld.length);
    expect(voll).toHaveLength(Math.floor(BASE64_DATEN_SUMME / feld.length));
    expect(voll.reduce((n, v) => n + v.length, 0)).toBeLessThanOrEqual(BASE64_DATEN_SUMME);
    expect(Object.values(k).filter(v => v.length === 300)).toHaveLength(6 - voll.length);
  });
  it('Verweis auf das gespeicherte Ergebnis liefert den vollen Wert (zert_base64 = {{schritt4.zertBase64}})', () => {
    const daten = kuerzeDaten({ zustand: 'ausgestellt', zertifikatPem: `-----BEGIN CERTIFICATE-----
${'P'.repeat(7000)}`, kettePem: 'K'.repeat(7000), zertBase64: b64(2000), issuingBase64: b64(1600), rootBase64: b64(1300) });
    const r = loeseAuf({ zert_base64: '{{schritt4.zertBase64}}', issuing_base64: '{{schritt4.issuingBase64}}', root_base64: '{{schritt4.rootBase64}}' }, [{ nr: 4, ok: true, daten } as never]);
    expect(r.fehler).toBeUndefined();
    expect(r.wert).toEqual({ zert_base64: b64(2000), issuing_base64: b64(1600), root_base64: b64(1300) });
    // PEM bleibt als Verweis unzulässig (Wert-Sicherheit unverändert)
    expect(loeseAuf({ zert_base64: '{{schritt4.zertifikatPem}}' }, [{ nr: 4, ok: true, daten } as never]).fehler).toContain('unzulässigen Wert');
  });
});
