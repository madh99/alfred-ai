import { describe, it, expect } from 'vitest';
import { LinuxHaSkill, linuxHaStatusText, clusterText, fencingText, FENCING_OHNE_RUECKWEG_GRUND, LINUX_HA_MIN_ZEITLIMIT_S, AG_FEHLER_MAX, agText, type LinuxHaStatus, type LinuxHaCluster, type LinuxHaAg } from './linux-ha-skill.js';
import { LinuxSqlSkill } from './linux-sql-skill.js';
import { LINUX_HA_BAUSTEINE, HA_KNOTEN, HA_VERSIONEN, HA_HACLUSTER_TRESOR, type FencingBeleg, type FencingTest } from './linux-ha.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';
import { ChangeMotor, type MotorDeps } from './change-motor.js';
import { rueckwegSchritte, type ChangeLauf } from './change-lauf.js';
import type { ChangeSchritt } from './change-schritte.js';
import type { CmdbChangeRequest } from '@alfred/types';

// I8e Paket 2 Task 2 — Skill linux_ha: HA-Grundlage je Knoten

interface Aufruf { zugang: string; baustein: string; parameter: unknown; eingabe?: string; timeoutMs: number; zweck: string }
const imChange = { ausChange: true } as never;

function welt(antworten: Record<string, Array<Record<string, unknown> | { code: number; stdout: string }>>, tresorDa: Record<string, string> = {}) {
  const aufrufe: Aufruf[] = [];
  const tresor = new Map<string, string>(Object.entries(tresorDa));
  const gesetzt: Array<{ name: string; wert: string; zweck: string }> = [];
  const protokolle: Array<{ msg: string; daten: Record<string, unknown> }> = [];
  const skill = new LinuxHaSkill({
    protokoll: (msg, daten) => { protokolle.push({ msg, daten }); },
    skript: async (zugang, baustein, parameter, eingabe, timeoutMs, zweck) => {
      aufrufe.push({ zugang, baustein, parameter, ...(eingabe !== undefined ? { eingabe } : {}), timeoutMs, zweck });
      const liste = antworten[baustein] ?? [];
      const a = liste.length > 1 ? liste.shift()! : liste[0];
      if (!a) return { code: 1, stdout: '', stderr: `kein Stub für ${baustein}` };
      if ('code' in a && 'stdout' in a) return { code: a.code as number, stdout: a.stdout as string, stderr: '' };
      return { code: a.zustand === 'fehler' ? 1 : 0, stdout: `irgendwas\nALFRED-HA ${JSON.stringify(a)}\n`, stderr: '' };
    },
    tresor: {
      namen: async () => new Set(tresor.keys()),
      lies: async (name) => { const w = tresor.get(name); if (w === undefined) throw new Error(`fehlt ${name}`); return w; },
      setze: async (name, wert, zweck) => { gesetzt.push({ name, wert, zweck }); tresor.set(name, wert); },
    },
  });
  return { skill, aufrufe, tresor, gesetzt, protokolle };
}

const SOLL = { pacemaker: '2.1.6-5ubuntu2', 'pacemaker-cli-utils': '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2', 'resource-agents-base': '1:4.13.0-1ubuntu4.2', 'mssql-server-ha': '17.0.4006.2-1' };
const STATUS_OK: LinuxHaStatus = {
  zustand: 'gelesen', watchdog: [{ geraet: 'watchdog0', kennung: 'i6300ESB timer', treiber: 'i6300esb' }], pciEsb: true, halter: [],
  pakete: { ...Object.fromEntries(Object.entries(SOLL).map(([k, v]) => [k, { version: v, gehalten: true }])), 'linux-modules-extra-6.8.0-147-generic': { version: '6.8.0-147.147', gehalten: false } },
  soll: SOLL, hadr: '1', sqlDienst: 'active', firewall: { tabelle: true, dienst: 'active', aktiviert: 'enabled' }, hosts: true, runtimeWatchdog: '0', sbdWartetAufWatchdog: true, pcsd: 'active', sql1433Zusatz: ['10.203.30.2', '10.203.30.20', '10.203.30.21', '192.168.1.223'],
  cluster: { art: 'keiner' },
  fencing: { bootId: 'b-1', jetztS: 1_795_000_000, identitaet: null, test: null, beleg: null },
};
const CLUSTER_OK: LinuxHaCluster = {
  art: 'eingerichtet', name: 'sqllnxcl01', knoten: HA_KNOTEN.map(k => ({ ...k })),
  crm: { knoten: 3, online: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], quorum: true, stonith: true, ressourcen: 0 },
  sbd: Object.fromEntries(HA_KNOTEN.map(k => [k.name, { installiert: true, aktiviert: true, laeuft: true }])), stonithWatchdogTimeout: '20',
};
const OK = { zustand: 'geaendert', knoten: 'sqllnx02', rolle: 'daten', watchdog: 'i6300ESB timer', pakete: SOLL, hadr: true, firewall: 'aktiv', pcsd: 'aktiv', neustartSql: true, aenderungen: ['pakete', 'hadr'] };

describe('I8e Paket 2 — Skill linux_ha', () => {
  it('ha_vorbereiten außerhalb eines Changes abgewiesen, ohne Fernaufruf; status auch außerhalb, ohne Geheimnis', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.status]: [STATUS_OK as never] });
    const r = await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'daten' }, {} as never);
    expect(r.error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(w.aufrufe).toEqual([]);
    const s = await w.skill.execute({ action: 'status', zugang: 'sqllnx02' }, {} as never);
    expect(s.success, s.error).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_HA_BAUSTEINE.status, parameter: {}, timeoutMs: 90_000 });
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    expect(s.display).toBe('sqllnx02: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223, 10.203.30.2, 10.203.30.20, 10.203.30.21); hosts-Block vorhanden; RuntimeWatchdog aus; sbd wartet auf Watchdog; pcsd aktiv; Cluster nicht eingerichtet; Fencing nicht belegt');
    expect((await w.skill.execute({ action: 'loeschen', zugang: 'sqllnx02' }, imChange)).error).toContain('Unbekannte Aktion');
  });

  const muster0 = () => new RegExp(`^${FESTE_AUSGABEN['linux_ha.status']!.split(' | ')[0]!.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
  it('Statustext: fester Wortlaut für Abweichungen; jede Form passt auf FESTE_AUSGABEN, positive Stücke stehen dort', () => {
    const v = (x: Partial<LinuxHaStatus>) => linuxHaStatusText('k', { ...STATUS_OK, ...x });
    expect(v({ watchdog: [], pciEsb: false })).toContain('Watchdog fehlt (kein i6300ESB in der VM)');
    expect(v({ watchdog: [], pciEsb: true })).toContain('Watchdog fehlt (i6300ESB in der VM, Modul nicht geladen)');
    expect(v({ watchdog: [{ geraet: 'watchdog0', kennung: 'Software Watchdog' }] })).toContain('Watchdog FREMD (watchdog0: Software Watchdog)');
    expect(v({ halter: [{ pid: 812, name: 'sbd', exe: '/usr/sbin/sbd' }] })).toContain('Watchdog i6300esb bei sbd');
    expect(v({ halter: [{ pid: 1, name: 'systemd', exe: '/usr/lib/systemd/systemd' }] })).toContain('Watchdog i6300esb BELEGT von systemd(1)');
    expect(v({ pakete: { ...STATUS_OK.pakete, pcs: { version: '0.11.8-1', gehalten: true }, sbd: { version: null, gehalten: false }, corosync: { version: SOLL.corosync, gehalten: false } } }))
      .toContain('Pakete abweichend: corosync nicht gehalten, pcs 0.11.8-1 (soll 0.11.7-1ubuntu1.1), sbd fehlt');
    // CU-Update (Owner 23./24.11.): mssql-server-ha folgt der installierten mssql-server-Version, nicht dem festen Einrichtungsstand
    const cu = { version: '17.0.5065.9-3', gehalten: true };
    expect(v({ pakete: { ...STATUS_OK.pakete, 'mssql-server': cu, 'mssql-server-ha': cu } })).toContain('Pakete fest;');
    expect(v({ pakete: { ...STATUS_OK.pakete, 'mssql-server': cu } })).toContain('Pakete abweichend: mssql-server-ha 17.0.4006.2-1 (soll 17.0.5065.9-3)');
    expect(v({ hadr: null, hosts: false, runtimeWatchdog: '10s', pcsd: 'inactive', firewall: { tabelle: false, dienst: 'inactive', aktiviert: 'disabled' } }))
      .toBe('k: Watchdog i6300esb frei; Pakete fest; HADR aus; Firewall alfred_ha nicht geladen, Dienst inactive, disabled; hosts-Block fehlt; RuntimeWatchdog AN (10s); sbd wartet auf Watchdog; pcsd inactive; Cluster nicht eingerichtet; Fencing nicht belegt');
    expect(v({ hostsLoopback: ['127.0.1.1 sqllnx02.ad.3033.at sqllnx02'] })).toContain('hosts-Block mit eigenem Namen auf Loopback (127.0.1.1 sqllnx02.ad.3033.at sqllnx02)');
    // Ruling R22: geladene Zusatzquellen ≠ HA_SQL_ZUSATZQUELLEN → „veraltet“ (auch leer = Satz fehlt); unbekannt → wie bisher
    const soll = 'Soll Knoten + 192.168.1.223, 10.203.30.2, 10.203.30.20, 10.203.30.21 — ha_vorbereiten stellt um';
    expect(v({ sql1433Zusatz: [] })).toContain(`; Firewall alfred_ha veraltet (1433: Knoten; ${soll}); `);
    expect(v({ sql1433Zusatz: ['192.168.1.223'] })).toContain(`; Firewall alfred_ha veraltet (1433: Knoten + 192.168.1.223; ${soll}); `);
    expect(v({ sql1433Zusatz: ['192.168.1.223', '10.203.30.2', '10.203.30.20', '10.203.30.21', '10.0.0.9'] })).toContain('Firewall alfred_ha veraltet (1433: Knoten + 192.168.1.223, 10.203.30.2, 10.203.30.20, 10.203.30.21, 10.0.0.9; Soll');
    // Ruling R31 (I8e L6): bestehende Knoten mit dem Satz nach R22 (ohne die Admin-Clients) melden „veraltet“, bis ha_vorbereiten umstellt
    expect(v({ sql1433Zusatz: ['10.203.30.2', '192.168.1.223'] })).toContain(`; Firewall alfred_ha veraltet (1433: Knoten + 10.203.30.2, 192.168.1.223; ${soll}); `);
    expect(v({ sql1433Zusatz: ['10.203.30.2', '192.168.1.223'] })).not.toContain('Firewall alfred_ha aktiv');
    expect(v({ sql1433Zusatz: ['10.203.30.2', '192.168.1.223', '10.203.30.20'] })).toContain('Firewall alfred_ha veraltet');
    // nft liefert die Menge sortiert — die Reihenfolge zählt nicht, die Menge schon
    expect(v({ sql1433Zusatz: ['10.203.30.2', '10.203.30.20', '10.203.30.21', '192.168.1.223'] })).toContain('; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223, 10.203.30.2, 10.203.30.20, 10.203.30.21); ');
    expect(v({ sql1433Zusatz: ['192.168.1.223'] })).not.toContain('Firewall alfred_ha aktiv');
    expect(v({ sql1433Zusatz: ['192.168.1.223'] })).toMatch(muster0());
    expect(v({ sql1433Zusatz: undefined })).toContain('; Firewall alfred_ha aktiv (1433: Knoten); ');
    // Ruling R10: alter Block (nur Kurznamen) heißt „veraltet“, nicht „fehlt“
    expect(v({ hosts: false, hostsVeraltet: true })).toContain('; hosts-Block veraltet (ohne FQDN — ha_vorbereiten stellt um); ');
    expect(v({ hosts: false, hostsVeraltet: true })).toMatch(muster0());
    // Live-Fix (c2e4f56d): sbd-Drop-in
    expect(v({ sbdWartetAufWatchdog: false })).toContain('; RuntimeWatchdog aus; sbd ohne Watchdog-Wartezeit (Drop-in fehlt); pcsd aktiv;');
    expect(v({ sbdWartetAufWatchdog: undefined })).toContain('; sbd Watchdog-Wartezeit unbekannt; ');
    expect(FESTE_AUSGABEN['linux_ha.status']!.split(' | ')).toContain('sbd wartet auf Watchdog');
    const vorlage = FESTE_AUSGABEN['linux_ha.status']!;
    const muster = new RegExp(`^${vorlage.split(' | ')[0]!.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    for (const t of [v({}), v({ watchdog: [], pciEsb: false, hadr: '0', hosts: false }), v({ cluster: CLUSTER_OK }), v({ cluster: undefined }), v({ fencing: undefined })]) expect(t).toMatch(muster);
    expect(vorlage).toContain(clusterText(CLUSTER_OK));
    for (const e of ['Watchdog i6300esb frei', 'Watchdog i6300esb bei sbd', 'Pakete fest', 'HADR an', 'Firewall alfred_ha aktiv', 'hosts-Block vorhanden', 'RuntimeWatchdog aus', 'pcsd aktiv']) expect(vorlage).toContain(e);
  });

  it('ha_vorbereiten: hacluster-Kennwort einmalig erzeugt, nur über stdin, nach Erfolg im Tresor; zweiter Lauf liest und meldet „nichts zu tun“', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [OK, { ...OK, zustand: 'schon', neustartSql: false, aenderungen: [] }] });
    const r = await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'daten' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.gesetzt.map(g => g.name)).toEqual([HA_HACLUSTER_TRESOR]);
    const kw = w.gesetzt[0]!.wert;
    expect(kw).toHaveLength(24);
    expect(w.aufrufe[0]).toMatchObject({ zugang: 'sqllnx02', baustein: LINUX_HA_BAUSTEINE.vorbereiten, timeoutMs: 1_500_000, parameter: { knoten: HA_KNOTEN, rolle: 'daten', versionen: HA_VERSIONEN } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ hacluster: kw });
    expect(r.display).toContain('✅ HA-Grundlage auf sqllnx02 (daten)');
    expect(r.display).toContain('SQL Server neu gestartet (HADR)');
    const r2 = await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnxcfg', rolle: 'konfig' }, imChange);
    expect(r2.display).toContain('nichts zu tun');
    expect(w.gesetzt).toHaveLength(1);
    expect(JSON.parse(w.aufrufe[1]!.eingabe!)).toEqual({ hacluster: kw });
    for (const a of w.aufrufe) { expect(JSON.stringify(a.parameter)).not.toContain(kw); expect(a.zweck).not.toContain(kw); }
    expect(JSON.stringify([r, r2])).not.toContain(kw);
    expect(r.display).not.toContain('auf FQDN umgestellt');
  });

  it('R10: ha_vorbereiten mit ersetztem altem hosts-Block meldet „hosts-Block auf FQDN umgestellt“', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [{ ...OK, zustand: 'geaendert', neustartSql: false, aenderungen: ['hosts-fqdn:/etc/hosts'] }] }, { [HA_HACLUSTER_TRESOR]: 'Hk-Wert-1234-abcd' });
    const r = await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx01', rolle: 'daten' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('; hosts-Block auf FQDN umgestellt — geändert: hosts-fqdn:/etc/hosts');
  });

  it('Fehler: vor dem Setzen kein Tresor-Eintrag; nach gesetztem Kennwort (Marke) trotz späterem Fehler im Tresor; Meldung geschwärzt', async () => {
    const vorher = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [{ zustand: 'fehler', fehler: 'kein i6300ESB-Watchdog (PCI 8086:25ab) in der VM — nichts geändert' }] });
    const r = await vorher.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx01', rolle: 'daten' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('kein i6300ESB');
    expect(vorher.gesetzt).toEqual([]);
    const nachher = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [{ code: 1, stdout: 'ALFRED-HACLUSTER-GESETZT\nALFRED-HA {"zustand":"fehler","fehler":"pcsd lässt sich nicht starten"}' }] });
    expect((await nachher.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx01', rolle: 'daten' }, imChange)).error).toContain('pcsd');
    expect(nachher.gesetzt.map(g => g.name)).toEqual([HA_HACLUSTER_TRESOR]);
    const geheim = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [{ code: 1, stdout: 'ALFRED-HA {"zustand":"fehler","fehler":"chpasswd mit Hk-Wert-9876 abgelehnt"}' }] }, { [HA_HACLUSTER_TRESOR]: 'Hk-Wert-9876' });
    const g = await geheim.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx01', rolle: 'daten' }, imChange);
    expect(g.error).toContain('chpasswd mit [geschwärzt] abgelehnt');
    expect(geheim.gesetzt).toEqual([]);
  });

  it('Parameter: rolle Pflicht, knoten genau drei; ungültig → vor jedem Fernaufruf abgewiesen; Planprüfung ohne Tresor', async () => {
    const w = welt({});
    expect((await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx02' }, imChange)).error).toContain('rolle');
    expect((await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'daten', knoten: HA_KNOTEN.slice(0, 2) }, imChange)).error).toContain('drei');
    expect(w.aufrufe).toEqual([]);
    expect(w.skill.pruefeEingabe({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'daten' })).toBeUndefined();
    expect(w.skill.pruefeEingabe({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'zeuge' })).toContain('rolle');
    expect(w.skill.pruefeEingabe({ action: 'ha_vorbereiten', zugang: 'sqllnx02', rolle: 'daten', knoten: [{ name: 'a', ip: 'x' }] })).toContain('knoten');
    expect(w.skill.pruefeEingabe({ action: 'status', zugang: '{{schritt1.name}}' })).toBeUndefined();
    expect(w.skill.mindestZeitlimitS('ha_vorbereiten')).toBe(LINUX_HA_MIN_ZEITLIMIT_S.ha_vorbereiten);
  });
});

// ── Planregeln ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('I8e Paket 2 — Change „sqllnx02 aufbauen“', () => {
  const ha = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const sql = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const proxmox = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['provision_vm', 'delete_vm', 'create_snapshot', 'rollback_snapshot', 'agent_status', 'set_vm_watchdog'] },
    template: { type: 'number' }, node: { type: 'string' }, storage: { type: 'string' }, hostname: { type: 'string' }, ip: { type: 'string' }, gateway: { type: 'string' },
    new_vmid: { type: 'number' }, vmid: { type: 'number' }, extra_disks: { type: 'array' }, name: { type: 'string' }, cores: { type: 'number' }, memory: { type: 'number' }, disk_size: { type: 'number' }, watchdog: { type: 'string' },
  }, required: ['action'] } } };
  const NEUE_VMS = new Set(['sqllnx02', 'sqllnxcfg']);
  const ctx = { skill: (n: string) => (n === 'linux_ha' ? ha : n === 'linux_sql' ? sql : n === 'proxmox' ? proxmox : undefined) as never, asset: (n: string) => (NEUE_VMS.has(n.toLowerCase()) ? undefined : { id: `a-${n}`, name: n }), changes: [] };
  const keiner = { keiner: 'Neuaufbau, Rückweg = VM löschen (Change-Ebene proxmox.delete_vm)' };
  const haStatus = (erwartet: string) => ({ typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang: 'sqllnx02' }, erwartet });
  const provision = { titel: 'VM bereitstellen', art: 'aktion', skill: 'proxmox', aktion: 'provision_vm', zeitlimitS: 1800,
    parameter: { template: 9020, node: 'pve3', storage: 'zfs-nvme002', hostname: 'sqllnx02', ip: '10.203.30.11/27', gateway: '10.203.30.1', new_vmid: 157, cores: 4, memory: 16384, extra_disks: [160, 80, 64, 128], watchdog: 'i6300esb' },
    rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 157 } }, pruefung: { typ: 'ping', ziel: '10.203.30.11' } };
  const PLATTEN = [{ scsi: 1, groesse_gib: 160, ziel: 'data' }, { scsi: 2, groesse_gib: 80, ziel: 'log' }, { scsi: 3, groesse_gib: 64, ziel: 'tempdb' }, { scsi: 4, groesse_gib: 128, ziel: 'backup' }];
  const paket1 = [
    { titel: 'Platten einrichten', art: 'aktion', skill: 'linux_sql', aktion: 'platten_einrichten', parameter: { zugang: 'sqllnx02', platten: PLATTEN }, zeitlimitS: 300, rueckweg: keiner },
    { titel: 'SQL Server installieren', art: 'aktion', skill: 'linux_sql', aktion: 'installieren', parameter: { zugang: 'sqllnx02', version: '17.0.4006.2-1' }, zeitlimitS: 1800, rueckweg: keiner },
    { titel: 'Konfigurieren', art: 'aktion', skill: 'linux_sql', aktion: 'konfigurieren', parameter: { zugang: 'sqllnx02', speicher_limit_mb: 12288, max_server_memory_mb: 10240 }, zeitlimitS: 1200, rueckweg: keiner },
  ];
  const vorbereiten = { titel: 'HA-Grundlage', art: 'aktion', skill: 'linux_ha', aktion: 'ha_vorbereiten', parameter: { zugang: 'sqllnx02', rolle: 'daten' }, zeitlimitS: 1600, rueckweg: keiner, pruefung: haStatus('Pakete fest') };
  const abschluss = { titel: 'Abschluss', art: 'pruefung', pruefung: haStatus('Firewall alfred_ha aktiv') };
  const plan = (schritte: unknown[], extra: Record<string, unknown> = {}) => ({ titel: 'sqllnx02 aufbauen', begruendung: 'I8e Paket 2 — zweites Datenreplikat', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['pve3'], schritte, ...extra });
  const NEU = { ohneSicherungGrund: 'neue VM sqllnx02, nichts Bestehendes betroffen' };

  it('Einordnung: status liest, ha_vorbereiten ändert', () => {
    expect(aktionsArt('linux_ha', 'status')).toBe('lesen');
    expect(aktionsArt('linux_ha', 'ha_vorbereiten')).toBe('aendern');
  });
  it('provision_vm mit Watchdog → Paket-1-Bausteine → ha_vorbereiten: 0 Fehler (auch ohne eigene Prüfung — prüft sich selbst)', () => {
    expect(pruefeChangePlan(plan([provision, ...paket1, vorbereiten, abschluss], NEU), ctx).fehler).toEqual([]);
    const { pruefung: _p, ...ohne } = vorbereiten;
    expect(pruefeChangePlan(plan([provision, ...paket1, ohne], NEU), ctx).fehler).toEqual([]);
  });
  it('Change „sqllnxcfg aufbauen“ (Ruling R5): OS 64 + eine 16-GiB-Platte mit Watchdog → platten data-only → installieren → konfigurieren 3072/2048 → ha_vorbereiten konfig: 0 Fehler', () => {
    const cfg = { ...provision, parameter: { ...provision.parameter, hostname: 'sqllnxcfg', new_vmid: 158, node: 'pve1', ip: '10.203.30.12/27', cores: 2, memory: 4096, disk_size: 64, extra_disks: [16] }, rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 158 } } };
    const schritte: Array<Record<string, unknown>> = [cfg,
      { ...paket1[0], parameter: { zugang: 'sqllnxcfg', platten: [{ scsi: 1, groesse_gib: 16, ziel: 'data' }] } },
      { ...paket1[1], parameter: { zugang: 'sqllnxcfg', version: '17.0.4006.2-1', einhaengepunkte: ['data'] } },
      { ...paket1[2], parameter: { zugang: 'sqllnxcfg', einhaengepunkte: ['data'], speicher_limit_mb: 3072, max_server_memory_mb: 2048 } },
      { ...vorbereiten, parameter: { zugang: 'sqllnxcfg', rolle: 'konfig' }, pruefung: undefined }];
    expect(pruefeChangePlan(plan(schritte, NEU), ctx).fehler).toEqual([]);
    const mit = (i: number, parameter: Record<string, unknown>) => { const t = [...schritte]; t[i] = { ...schritte[i], parameter }; return pruefeChangePlan(plan(t, NEU), ctx).fehler; };
    expect(mit(2, { zugang: 'sqllnxcfg', version: '17.0.4006.2-1', einhaengepunkte: ['data', 'log'] }).some(f => f.startsWith('Schritt 3:') && f.includes('einhaengepunkte'))).toBe(true);
    expect(mit(1, { zugang: 'sqllnxcfg', platten: [{ scsi: 1, groesse_gib: 20, ziel: 'data' }] }).some(f => f.startsWith('Schritt 2:') && f.includes('genau 16 GiB'))).toBe(true);
    expect(mit(3, { zugang: 'sqllnxcfg', einhaengepunkte: ['data', 'tempdb'], speicher_limit_mb: 3072, max_server_memory_mb: 2048 }).some(f => f.startsWith('Schritt 4:') && f.includes('einhaengepunkte'))).toBe(true);
  });
  it('bestehende VM ohne Bereitstellung und ohne Sicherung → Rückweg verlangt (Neuaufbau-Regel gilt auch für linux_ha)', () => {
    const f = pruefeChangePlan(plan([{ ...vorbereiten, parameter: { zugang: 'sqllnx01', rolle: 'daten' } }]), ctx).fehler;
    expect(f.some(x => x.startsWith('Schritt 1:') && x.includes('linux_ha.ha_vorbereiten ohne Rückweg nur beim Neuaufbau'))).toBe(true);
  });
  it('zeitlimitS unter der Baustein-Grenze und erwartet außerhalb des festen Wortlauts werden abgewiesen', () => {
    const f = pruefeChangePlan(plan([provision, ...paket1, { ...vorbereiten, zeitlimitS: 600, pruefung: haStatus('Cluster läuft prima') }], NEU), ctx).fehler;
    expect(f.some(x => x.includes('zeitlimitS 600 zu klein für linux_ha.ha_vorbereiten'))).toBe(true);
    expect(f.some(x => x.includes('linux_ha.status') && x.includes('kommt in der Antwort'))).toBe(true);
  });
});

// ── Task 3: Cluster ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('I8e Paket 2 Task 3 — Skill linux_ha: Cluster', () => {
  const KW = 'Hk-Tresor-Wert-77';
  const CL_OK = { zustand: 'geaendert', cluster: 'sqllnxcl01', ausgefuehrtAuf: 'sqllnx01', knoten: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], online: 3, quorum: '3/3', stonith: true, sbd: '3/3', sbdTimeoutS: 10, stonithWatchdogTimeoutS: 20, haveWatchdog: true, aenderungen: ['pcs-anmeldung', 'cluster-angelegt'] };

  it('Statustext Cluster: fester Wortlaut wie im Brief, Abweichungen lesbar', () => {
    expect(clusterText(CLUSTER_OK)).toBe('Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s');
    expect(clusterText({ ...CLUSTER_OK, stonithWatchdogTimeout: '20s' })).toContain('stonith-watchdog-timeout 20s');
    expect(clusterText({ ...CLUSTER_OK, stonithWatchdogTimeout: null })).toContain('stonith-watchdog-timeout nicht gesetzt');
    expect(clusterText({ ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, online: ['sqllnx01', 'sqllnx02'], quorum: false, stonith: false }, sbd: { sqllnx01: { installiert: true, aktiviert: true, laeuft: true } } }))
      .toBe('Cluster sqllnxcl01: 2/3 online, Quorum nein, STONITH aus, SBD aktiv 1/3, stonith-watchdog-timeout 20s');
    expect(clusterText({ ...CLUSTER_OK, crm: null })).toBe('Cluster sqllnxcl01: Pacemaker hier nicht aktiv (3 Knoten konfiguriert)');
    expect(clusterText({ ...CLUSTER_OK, sbd: null })).toContain('SBD unbekannt');
    expect(clusterText({ art: 'keiner' })).toBe('Cluster nicht eingerichtet');
    expect(clusterText({ art: 'debian' })).toBe('Cluster nicht eingerichtet (Debian-Standardkonfiguration)');
    expect(clusterText(undefined)).toBe('Cluster unbekannt');
    expect(linuxHaStatusText('sqllnx01', { ...STATUS_OK, cluster: CLUSTER_OK })).toMatch(/; pcsd aktiv; Cluster sqllnxcl01: 3\/3 online, Quorum ja, STONITH an, SBD aktiv 3\/3, stonith-watchdog-timeout 20s; Fencing nicht belegt$/);
  });

  it('cluster_anlegen nur im Change; ohne Tresor-Eintrag kein Fernaufruf; Kennwort nur über stdin, nie in Parametern/Zweck/Ergebnis', async () => {
    const ohne = welt({ [LINUX_HA_BAUSTEINE.cluster]: [CL_OK] });
    expect((await ohne.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    const r0 = await ohne.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01' }, imChange);
    expect(r0.error).toContain('vorher ha_vorbereiten');
    expect(ohne.aufrufe).toEqual([]);
    expect(ohne.gesetzt).toEqual([]);
    const w = welt({ [LINUX_HA_BAUSTEINE.cluster]: [CL_OK, { ...CL_OK, zustand: 'schon', aenderungen: [] }] }, { [HA_HACLUSTER_TRESOR]: KW });
    const r = await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ zugang: 'sqllnx01', baustein: LINUX_HA_BAUSTEINE.cluster, timeoutMs: 900_000,
      parameter: { cluster: 'sqllnxcl01', knoten: HA_KNOTEN, sbd_timeout_s: 10, stonith_timeout_s: 20 } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ hacluster: KW });
    expect(r.display).toBe('✅ Cluster sqllnxcl01 (sqllnx01, sqllnx02, sqllnxcfg, ausgeführt auf sqllnx01): 3/3 online, Quorum 3/3, STONITH an, SBD diskless (Watchdog /dev/watchdog, SBD_WATCHDOG_TIMEOUT 10 s) aktiv 3/3, stonith-watchdog-timeout 20 s, have-watchdog true — geändert: pcs-anmeldung, cluster-angelegt');
    const r2 = await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx02', knoten: ['sqllnxcfg', 'sqllnx02', 'sqllnx01'] }, imChange);
    expect(r2.display).toContain('nichts zu tun');
    // Reihenfolge immer wie HA_KNOTEN (nodeid stabil)
    expect((w.aufrufe[1]!.parameter as { knoten: unknown }).knoten).toEqual(HA_KNOTEN);
    for (const a of w.aufrufe) { expect(JSON.stringify(a.parameter)).not.toContain(KW); expect(a.zweck).not.toContain(KW); }
    expect(JSON.stringify([r, r2])).not.toContain(KW);
    expect(w.gesetzt).toEqual([]);
  });

  it('Parameter: Validator stonith ≥ 2 × sbd, nur die festen Knoten, Zahlen als Text erlaubt — Fehler vor jedem Fernaufruf; Meldungen geschwärzt', async () => {
    const w = welt({}, { [HA_HACLUSTER_TRESOR]: KW });
    expect((await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01', stonith_timeout_s: 19 }, imChange)).error).toContain('mindestens 2 × sbd_timeout_s sein (20)');
    expect((await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01', knoten: ['sqllnx01', 'sqllnx02', 'sqllnx09'] }, imChange)).error).toContain('knoten: nur sqllnx01, sqllnx02, sqllnxcfg');
    expect((await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01', knoten: ['sqllnx01', 'sqllnx02'] }, imChange)).error).toContain('genau die drei Knoten');
    expect((await w.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01', knoten: [{ name: 'sqllnx01', ip: '10.0.0.1' }, 'sqllnx02', 'sqllnxcfg'] }, imChange)).error).toContain('feste IP 10.203.30.10');
    expect((await w.skill.execute({ action: 'cluster_entfernen', zugang: 'sqllnx01', cluster: 'Debian!' }, imChange)).error).toContain('cluster:');
    expect(w.aufrufe).toEqual([]);
    expect(w.skill.pruefeEingabe({ action: 'cluster_anlegen', zugang: 'sqllnx01', sbd_timeout_s: '15', stonith_timeout_s: '30' })).toBeUndefined();
    expect(w.skill.pruefeEingabe({ action: 'cluster_anlegen', zugang: 'sqllnx01', sbd_timeout_s: 15 })).toContain('(30)');
    expect(w.skill.mindestZeitlimitS('cluster_anlegen')).toBe(960);
    expect(w.skill.mindestZeitlimitS('cluster_entfernen')).toBe(660);
    const g = welt({ [LINUX_HA_BAUSTEINE.cluster]: [{ code: 1, stdout: `ALFRED-HA {"zustand":"fehler","fehler":"pcs host auth (hacluster) fehlgeschlagen: ${KW} abgelehnt"}` }] }, { [HA_HACLUSTER_TRESOR]: KW });
    const e = await g.skill.execute({ action: 'cluster_anlegen', zugang: 'sqllnx01' }, imChange);
    expect(e.error).toContain('[geschwärzt] abgelehnt');
    expect(e.error).not.toContain(KW);
  });

  it('cluster_entfernen: Tresor-Kennwort über stdin, fester Text, „nichts zu tun“ beim zweiten Lauf', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.clusterEntfernen]: [{ zustand: 'geaendert', cluster: 'sqllnxcl01', aenderungen: ['cluster-gestoppt', 'sbd-aus', 'cluster-entfernt'] }, { zustand: 'schon', aenderungen: [] }] }, { [HA_HACLUSTER_TRESOR]: KW });
    const r = await w.skill.execute({ action: 'cluster_entfernen', zugang: 'sqllnx01', cluster: 'sqllnxcl01' }, imChange);
    expect(r.display).toBe('✅ Cluster sqllnxcl01 auf sqllnx01, sqllnx02, sqllnxcfg entfernt (SBD aus, Cluster-Dienste aus, keine corosync.conf von sqllnxcl01 mehr) — geändert: cluster-gestoppt, sbd-aus, cluster-entfernt');
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_HA_BAUSTEINE.clusterEntfernen, timeoutMs: 600_000, parameter: { cluster: 'sqllnxcl01', knoten: HA_KNOTEN } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ hacluster: KW });
    expect((await w.skill.execute({ action: 'cluster_entfernen', zugang: 'sqllnx01' }, imChange)).display).toContain('nichts zu tun');
  });
});

describe('I8e Paket 2 Task 3 — Change „Cluster sqllnxcl01 anlegen“', () => {
  const ha = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const proxmox = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['provision_vm', 'create_snapshot', 'rollback_snapshot'] }, vmid: { type: 'number' }, node: { type: 'string' }, name: { type: 'string' },
  }, required: ['action'] } } };
  const ctx = { skill: (n: string) => (n === 'linux_ha' ? ha : n === 'proxmox' ? proxmox : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const anlegen = { titel: 'Cluster anlegen', art: 'aktion', skill: 'linux_ha', aktion: 'cluster_anlegen', parameter: { zugang: 'sqllnx01' }, zeitlimitS: 1000,
    rueckweg: { skill: 'linux_ha', aktion: 'cluster_entfernen', parameter: { zugang: 'sqllnx01', cluster: 'sqllnxcl01' } } };
  const status = { titel: 'Cluster prüfen', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang: 'sqllnx02' }, erwartet: '3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3' } };
  const plan = (schritte: unknown[]) => ({ titel: 'Cluster sqllnxcl01 anlegen', begruendung: 'I8e Paket 2 Task 3', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], schritte, ohneSicherungGrund: 'Cluster-Anlage hat einen eigenen Rückweg (cluster_entfernen)' });

  it('cluster_anlegen mit Rückweg cluster_entfernen, ohne eigene Prüfung (prüft sich selbst), Status-Prüfung mit festem Wortlaut: 0 Fehler', () => {
    expect(aktionsArt('linux_ha', 'cluster_anlegen')).toBe('aendern');
    expect(aktionsArt('linux_ha', 'cluster_entfernen')).toBe('aendern');
    expect(pruefeChangePlan(plan([anlegen, status]), ctx).fehler).toEqual([]);
  });
  it('ohne Rückweg abgewiesen — auch mit ohneSicherungGrund; zu kleines zeitlimitS und ungültige Zeitwerte schon beim Planen', () => {
    const f = pruefeChangePlan(plan([{ ...anlegen, rueckweg: { keiner: 'Neuaufbau' } }]), ctx).fehler;
    expect(f.some(x => x.startsWith('Schritt 1:') && x.includes('braucht immer einen Rückweg — rueckweg linux_ha.cluster_entfernen'))).toBe(true);
    const z = pruefeChangePlan(plan([{ ...anlegen, zeitlimitS: 600, parameter: { zugang: 'sqllnx01', stonith_timeout_s: 15 } }]), ctx).fehler;
    expect(z.some(x => x.includes('zeitlimitS 600 zu klein für linux_ha.cluster_anlegen'))).toBe(true);
    expect(z.some(x => x.includes('mindestens 2 × sbd_timeout_s'))).toBe(true);
    expect(pruefeChangePlan(plan([anlegen, { ...status, pruefung: { ...status.pruefung, erwartet: 'Cluster läuft super' } }]), ctx).fehler.some(x => x.includes('kommt in der Antwort'))).toBe(true);
  });
  // Task 4, Carry-over 4: Pflicht-Rückweg heißt genau linux_ha.cluster_entfernen
  it('Rückweg muss genau linux_ha.cluster_entfernen sein — ein anderer (z. B. status, ha_vorbereiten, proxmox) wird abgewiesen', () => {
    for (const rueckweg of [{ skill: 'linux_ha', aktion: 'status', parameter: { zugang: 'sqllnx01' } }, { skill: 'linux_ha', aktion: 'ha_vorbereiten', parameter: { zugang: 'sqllnx01', rolle: 'daten' } },
      { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: 156, name: 'x' } }]) {
      const f = pruefeChangePlan(plan([{ ...anlegen, rueckweg }, status]), ctx).fehler;
      expect(f.some(x => x.startsWith('Schritt 1:') && x.includes(`braucht als Rückweg genau linux_ha.cluster_entfernen (zugang, cluster), nicht ${rueckweg.skill}.${rueckweg.aktion}`)), JSON.stringify(f)).toBe(true);
    }
  });
});

// ── Task 4: Fencing-Beweis ──────────────────────────────────────────────────────────────────────────────────────────────────────
const ID01 = { cluster: 'sqllnxcl01', knoten: 'sqllnx01', nodeid: '1', konfHash: 'h1' };
const BELEG01: FencingBeleg = { art: 'trennung', zeit: '2026-11-17T14:03:41Z', resetS: 18, rejoinS: 41, bootId: 'b-neu', bootIdVorher: 'a-alt', testZeit: '2026-11-17T14:00:00Z',
  cluster: 'sqllnxcl01', knoten: 'sqllnx01', nodeid: '1', konfHash: 'h1', journalLueckeS: 17 };
const TEST01: FencingTest = { art: 'trennung', bootIdVorher: 'a-alt', zeit: '2026-11-17T14:00:00Z', zeitS: 1_795_000_000, ausloeseS: 1_795_000_003, sperreS: 120, knoten: 'sqllnx01', cluster: 'sqllnxcl01', nodeid: '1', konfHash: 'h1' };

describe('I8e Paket 2 Task 4 — Skill linux_ha: Fencing', () => {
  it('Statustext Fencing: belegt, Reset ausstehend, ohne Reset, Beleg ausstehend, ungültig, nicht belegt, unbekannt — passt auf FESTE_AUSGABEN', () => {
    const jetzt = 1_795_000_200;
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: BELEG01 })).toBe('Fencing belegt (trennung, 2026-11-17 14:03 UTC, Reset 18 s, Rejoin 41 s)');
    expect(fencingText({ bootId: 'a-alt', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: null })).toBe('Fencing Test trennung ausgelöst, Reset ausstehend');
    expect(fencingText({ bootId: 'a-alt', jetztS: jetzt + 1801, identitaet: ID01, test: TEST01, beleg: null })).toBe('Fencing Test trennung vom 2026-11-17 14:00 UTC ohne Reset (boot_id unverändert)');
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: null })).toBe('Fencing Test trennung vom 2026-11-17 14:00 UTC erfolgt, Beleg ausstehend (fencing_belegen)');
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: { ...ID01, konfHash: 'h2' }, test: TEST01, beleg: BELEG01 })).toBe('Fencing Beleg ungültig (Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey/SBD-Konfiguration anders))');
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: null, beleg: null })).toBe('Fencing nicht belegt');
    expect(fencingText(undefined)).toBe('Fencing unbekannt');
    // Fix-Runde 1: liegengebliebene Test-Sperre sichtbar
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: BELEG01, sperreAktiv: true })).toBe('Fencing belegt (trennung, 2026-11-17 14:03 UTC, Reset 18 s, Rejoin 41 s) — Corosync-Sperre alfred_fencetest AKTIV');
    expect(fencingText({ bootId: 'a-alt', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: null, sperreAktiv: true })).toBe('Fencing Test trennung ausgelöst, Reset ausstehend — Corosync-Sperre alfred_fencetest AKTIV');
    expect(linuxHaStatusText('k', { ...STATUS_OK, fencing: { ...STATUS_OK.fencing!, sperreAktiv: true } })).toMatch(/; Fencing nicht belegt — Corosync-Sperre alfred_fencetest AKTIV$/);
    // neuerer Test auf einem Knoten mit altem Beleg, Reset noch aus → „Reset ausstehend“ (die Warte-Prüfung schließt das aus)
    expect(fencingText({ bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: { ...TEST01, bootIdVorher: 'b-neu', zeit: '2026-11-17T15:00:00Z' }, beleg: BELEG01 })).toContain('Reset ausstehend');
    const vorlage = FESTE_AUSGABEN['linux_ha.status']!;
    expect(vorlage).toContain('; Fencing {fencing}');
    expect(vorlage.split(' | ')).toContain('Fencing belegt');
    const t = linuxHaStatusText('sqllnx01', { ...STATUS_OK, cluster: CLUSTER_OK, fencing: { bootId: 'b-neu', jetztS: jetzt, identitaet: ID01, test: TEST01, beleg: BELEG01 } });
    expect(t).toMatch(/; Cluster sqllnxcl01: 3\/3 online, .*; Fencing belegt \(trennung, /);
  });

  it('fencing_pruefen nur im Change; Kennwort nur über stdin; Parameter vor jedem Fernaufruf geprüft; fester Text für ausgeloest und schon', async () => {
    const KW = 'Hk-Tresor-Wert-77';
    const aus = { zustand: 'ausgeloest', art: 'trennung', knoten: 'sqllnx02', cluster: 'sqllnxcl01', bootIdVorher: 'a-alt', ausloesungInS: 10, sperreS: 120, aenderungen: ['fencing-test-datei', 'aufheben-geplant', 'ausloeser-geplant'] };
    const w = welt({ [LINUX_HA_BAUSTEINE.fencingPruefen]: [aus, { zustand: 'schon', art: 'trennung', hinweis: 'Reset nach dem Test vom 2026-11-17T14:00:00Z erfolgt — Beleg mit fencing_belegen', aenderungen: [] }] }, { [HA_HACLUSTER_TRESOR]: KW });
    expect((await w.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02', art: 'trennung' }, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect((await w.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02', art: 'reboot' }, imChange)).error).toContain('art: trennung oder haenger');
    expect((await w.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02' }, imChange)).error).toContain('art:');
    expect(w.aufrufe).toEqual([]);
    const r = await w.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02', art: 'Trennung' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_HA_BAUSTEINE.fencingPruefen, timeoutMs: 180_000, parameter: { cluster: 'sqllnxcl01', knoten: HA_KNOTEN, art: 'trennung' } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ hacluster: KW });
    expect(r.display).toBe('Fencing-Test trennung auf sqllnx02 (sqllnx02) ausgelöst: Corosync (UDP 5405) ab +10 s für 120 s gesperrt; boot_id vorher a-alt — Reset durch SBD erwartet, danach fencing_belegen — geändert: fencing-test-datei, aufheben-geplant, ausloeser-geplant');
    const r2 = await w.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02', art: 'trennung' }, imChange);
    expect(r2.display).toBe('Fencing-Test trennung auf sqllnx02: Reset nach dem Test vom 2026-11-17T14:00:00Z erfolgt — Beleg mit fencing_belegen — nichts zu tun');
    expect(JSON.stringify([r, r2, w.aufrufe.map(a => [a.parameter, a.zweck])])).not.toContain(KW);
    const ohne = welt({});
    expect((await ohne.skill.execute({ action: 'fencing_pruefen', zugang: 'sqllnx02', art: 'trennung' }, imChange)).error).toContain('vorher ha_vorbereiten');
    expect(ohne.aufrufe).toEqual([]);
    expect(w.skill.mindestZeitlimitS('fencing_pruefen')).toBe(240);
    expect(w.skill.mindestZeitlimitS('fencing_belegen')).toBe(360);
    expect(w.skill.pruefeEingabe({ action: 'fencing_pruefen', zugang: 'sqllnxcfg', art: 'haenger' })).toBeUndefined();
    expect(w.skill.pruefeEingabe({ action: 'fencing_pruefen', zugang: 'sqllnxcfg', art: 'kaputt' })).toContain('art:');
  });

  it('fencing_belegen: ohne Geheimnis, fester Text mit Messwerten; ein Ergebnis ohne gültigen Beleg ist ein Fehler', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.fencingBelegen]: [{ zustand: 'geaendert', knoten: 'sqllnx01', beleg: BELEG01, aenderungen: ['fencing-beleg'] }, { zustand: 'schon', beleg: BELEG01, aenderungen: [] },
      { zustand: 'geaendert', beleg: { ...BELEG01, bootId: 'a-alt' }, aenderungen: ['fencing-beleg'] }] });
    const r = await w.skill.execute({ action: 'fencing_belegen', zugang: 'sqllnx01' }, imChange);
    expect(r.display).toBe('✅ Fencing auf sqllnx01 (sqllnx01) belegt (trennung, 2026-11-17 14:03 UTC): Reset 18 s nach der Auslösung, Rejoin 41 s nach dem Start (Quorum); boot_id a-alt → b-neu — geändert: fencing-beleg');
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_HA_BAUSTEINE.fencingBelegen, timeoutMs: 300_000, parameter: { cluster: 'sqllnxcl01', knoten: HA_KNOTEN } });
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    expect((await w.skill.execute({ action: 'fencing_belegen', zugang: 'sqllnx01' }, imChange)).display).toContain('— nichts zu tun');
    const f = await w.skill.execute({ action: 'fencing_belegen', zugang: 'sqllnx01' }, imChange);
    expect(f.success).toBe(false);
    expect(f.error).toContain('Ergebnis ohne gültigen Beleg (Beleg ohne Reset (boot_id gleich))');
    expect((await w.skill.execute({ action: 'fencing_belegen', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
  });
});

describe('I8e Paket 2 Task 4 — Change „Fencing-Beweis“', () => {
  const ha = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'linux_ha' ? ha : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const je = (zugang: string, art: 'trennung' | 'haenger') => [
    { titel: `Fencing-Test ${art} ${zugang}`, art: 'aktion', skill: 'linux_ha', aktion: 'fencing_pruefen', parameter: { zugang, art }, zeitlimitS: 300, rueckweg: { keiner: FENCING_OHNE_RUECKWEG_GRUND } },
    { titel: `${zugang} wieder im Cluster`, art: 'warten', sekunden: 45, zeitlimitS: 600,
      pruefung: { typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang }, erwartet: '3/3 online', nichtEnthalten: 'Reset ausstehend' } },
    { titel: `Fencing-Beleg ${zugang}`, art: 'aktion', skill: 'linux_ha', aktion: 'fencing_belegen', parameter: { zugang }, zeitlimitS: 400, rueckweg: { keiner: 'schreibt nur die Beleg-Datei des Knotens' } },
  ];
  const abschluss = (zugang: string) => ({ titel: `Beleg ${zugang}`, art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang }, erwartet: 'Fencing belegt' } });
  const schritte = [...je('sqllnx01', 'trennung'), ...je('sqllnx02', 'trennung'), ...je('sqllnxcfg', 'trennung'), ...je('sqllnxcfg', 'haenger'), ...['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(abschluss)];
  const plan = (s: unknown[], extra: Record<string, unknown> = { ohneSicherungGrund: 'Fencing-Test setzt nur den jeweiligen Testknoten zurück; keine Daten- oder Konfigurationsänderung' }) =>
    ({ titel: 'Fencing-Beweis sqllnxcl01', begruendung: 'I8e Paket 2 Task 4 — Beleg je Knoten vor dem AG-Aufbau', typ: 'normal', risiko: 'hoch', ausfallMinuten: 5, betroffen: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], schritte: s, ...extra });

  it('je Knoten fencing_pruefen → warten bis status „3/3 online“ ohne „Reset ausstehend“ → fencing_belegen, dazu haenger auf sqllnxcfg: 0 Fehler', () => {
    expect(aktionsArt('linux_ha', 'fencing_pruefen')).toBe('aendern');
    expect(aktionsArt('linux_ha', 'fencing_belegen')).toBe('aendern');
    expect(pruefeChangePlan(plan(schritte), ctx).fehler).toEqual([]);
  });
  it('fencing_pruefen: kein Rückweg nur mit genau dem Grund; ein angegebener Rückweg oder anderer Grund wird abgewiesen; zu kleines zeitlimitS', () => {
    const mit = (rueckweg: unknown) => pruefeChangePlan(plan([{ ...je('sqllnx02', 'trennung')[0], rueckweg }]), ctx).fehler;
    expect(mit({ keiner: FENCING_OHNE_RUECKWEG_GRUND })).toEqual([]);
    expect(mit({ keiner: 'Neuaufbau' }).some(x => x.includes(`linux_ha.fencing_pruefen hat keinen Rückweg — rueckweg {keiner: „${FENCING_OHNE_RUECKWEG_GRUND}“}`))).toBe(true);
    expect(mit({ skill: 'linux_ha', aktion: 'cluster_entfernen', parameter: { zugang: 'sqllnx02' } }).some(x => x.includes('hat keinen Rückweg'))).toBe(true);
    expect(mit(undefined).some(x => x.includes('rueckweg fehlt') && x.includes(FENCING_OHNE_RUECKWEG_GRUND))).toBe(true);
    const z = pruefeChangePlan(plan([{ ...je('sqllnx02', 'trennung')[0], zeitlimitS: 120 }]), ctx).fehler;
    expect(z.some(x => x.includes('zeitlimitS 120 zu klein für linux_ha.fencing_pruefen — mindestens 240 s'))).toBe(true);
  });
  it('fencing_belegen ohne Rückweg auch ohne ohneSicherungGrund zulässig (schreibt nur die Beleg-Datei); Status-Erwartung außerhalb des Wortlauts abgewiesen', () => {
    const f = pruefeChangePlan(plan(je('sqllnx02', 'trennung'), {}), ctx).fehler;
    expect(f.filter(x => !x.startsWith('Vor der ersten ändernden Aktion'))).toEqual([]);
    const e = pruefeChangePlan(plan([abschluss('sqllnx01'), { ...abschluss('sqllnx02'), pruefung: { ...abschluss('sqllnx02').pruefung, erwartet: 'Fencing bewiesen' } }]), ctx).fehler;
    expect(e.some(x => x.startsWith('Schritt 2:') && x.includes('kommt in der Antwort'))).toBe(true);
  });
});

// ── Task 5: Verfügbarkeitsgruppe ────────────────────────────────────────────────────────────────────────────────────────────────
const zert = (fuell: string) => `30820010${fuell.repeat(16)}`; // DER-SEQUENCE mit 16 Inhaltsbytes (öffentliches Zertifikat, Form)
const ZERT: Record<string, string> = { sqllnx01: zert('A1'), sqllnx02: zert('B2'), sqllnxcfg: zert('C3') };
const FP: Record<string, string> = { sqllnx01: '1'.repeat(40), sqllnx02: '2'.repeat(40), sqllnxcfg: '3'.repeat(40) };
const IP: Record<string, string> = Object.fromEntries(HA_KNOTEN.map(k => [k.name, k.ip]));
const fencingOk = (k: string, nodeid: string) => ({ bootId: 'b-neu', jetztS: 1_795_000_200, sperreAktiv: false, identitaet: { cluster: 'sqllnxcl01', knoten: k, nodeid, konfHash: 'h1' }, test: { ...TEST01, knoten: k, nodeid }, beleg: { ...BELEG01, knoten: k, nodeid } });
const statusAg = (k: string, nodeid: string, extra: Partial<LinuxHaStatus> = {}) => ({ ...STATUS_OK, cluster: CLUSTER_OK, fencing: fencingOk(k, nodeid), ...extra });
const STATUS_3 = [statusAg('sqllnx01', '1'), statusAg('sqllnx02', '2'), statusAg('sqllnxcfg', '3')];
const endpunkt = (k: string, zustand = 'geaendert') => ({ zustand, knoten: k, endpunkt: `TCP://${IP[k]}:5022`, fingerabdruck: FP[k], zertifikat: ZERT[k], aenderungen: zustand === 'schon' ? [] : ['zertifikat', 'endpunkt', 'pacemaker-login', 'pacemaker-zugangsdatei'] });
const replikat = (k: string, rolle: string, zustand = 'geaendert') => ({ zustand, knoten: k, rolle, aenderungen: zustand === 'schon' ? [] : [rolle === 'primaer' ? 'ag-angelegt' : 'beigetreten'] });
const ABSCHLUSS = { zustand: 'geaendert', ag: 'sqllnxag01', primaer: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg', clusterTyp: 'EXTERNAL', requiredSyncSql: 0, requiredSyncRessource: '0', sicherungVorgabe: 'PRIMARY',
  datenbanken: [{ name: 'alfredpruef', zustand: 'SYNCHRONIZED' }], vip: '10.203.30.13/27', vipAuf: 'sqllnx01', promotedAuf: 'sqllnx01', aenderungen: ['db-alfredpruef', 'ressource-ag', 'ressource-vip', 'kolokation', 'reihenfolge', 'vip-aktiviert'] };
const AG_TRESOR = { [HA_HACLUSTER_TRESOR]: 'Hk-Tresor-Wert-77', 'sqllnx-sqllnx01-sa': 'Sa-Eins-1111', 'sqllnx-sqllnx02-sa': 'Sa-Zwei-2222', 'sqllnx-sqllnxcfg-sa': 'Sa-Drei-3333' };
const AG_EINGABE = { action: 'ag_anlegen', zugang: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg', datenbanken: ['alfredpruef'] };
const AG_SCHRITTE = [LINUX_HA_BAUSTEINE.agEndpunkt, LINUX_HA_BAUSTEINE.agReplikat, LINUX_HA_BAUSTEINE.agAbschluss, LINUX_HA_BAUSTEINE.agEntfernen] as string[];

describe('I8e Paket 2 Task 5 — Skill linux_ha: ag_anlegen / ag_entfernen', () => {
  const voll = (extra: Record<string, unknown[]> = {}, tresor: Record<string, string> = AG_TRESOR) => welt({
    [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[],
    [LINUX_HA_BAUSTEINE.agEndpunkt]: [endpunkt('sqllnx01'), endpunkt('sqllnx02'), endpunkt('sqllnxcfg')],
    [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer'), replikat('sqllnx02', 'sekundaer'), replikat('sqllnxcfg', 'konfig')],
    [LINUX_HA_BAUSTEINE.agAbschluss]: [ABSCHLUSS],
    ...extra as Record<string, never[]>,
  }, tresor);

  it('nur im Change; Fencing-Gate: ohne gültigen Beleg auf allen drei Knoten Abbruch vor jeder SQL-Zeile (nur Status gelesen, nichts im Tresor)', async () => {
    const w = voll();
    expect((await w.skill.execute(AG_EINGABE, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(w.aufrufe).toEqual([]);
    for (const kaputt of [
      { i: 1, s: statusAg('sqllnx02', '2', { fencing: { ...fencingOk('sqllnx02', '2'), beleg: null } }), grund: 'sqllnx02: kein Fencing-Beleg' },
      { i: 2, s: statusAg('sqllnxcfg', '3', { fencing: { ...fencingOk('sqllnxcfg', '3'), identitaet: { cluster: 'sqllnxcl01', knoten: 'sqllnxcfg', nodeid: '3', konfHash: 'h2' } } }), grund: 'sqllnxcfg: Cluster seit dem Beleg neu eingerichtet' },
      { i: 0, s: statusAg('sqllnx01', '1', { fencing: undefined }), grund: 'sqllnx01: kein Fencing-Beleg' },
    ]) {
      const st = [...STATUS_3]; st[kaputt.i] = kaputt.s as never;
      const v = voll({ [LINUX_HA_BAUSTEINE.status]: st });
      const r = await v.skill.execute(AG_EINGABE, imChange);
      expect(r.success).toBe(false);
      expect(r.error).toContain('Fencing nicht auf allen drei Knoten belegt');
      expect(r.error).toContain(kaputt.grund);
      expect(r.error).toContain('nichts geändert');
      expect(v.aufrufe.map(a => a.baustein).every(b => b === LINUX_HA_BAUSTEINE.status)).toBe(true);
      expect(v.aufrufe.filter(a => AG_SCHRITTE.includes(a.baustein))).toEqual([]);
      expect(v.aufrufe.every(a => a.eingabe === undefined)).toBe(true);
      expect(v.gesetzt).toEqual([]);
    }
    // Zugang zeigt auf einen anderen Knoten, Cluster nicht 3/3 → ebenfalls Abbruch vor jeder SQL-Zeile
    const fremd = voll({ [LINUX_HA_BAUSTEINE.status]: [STATUS_3[0], statusAg('sqllnx01', '1'), STATUS_3[2]] });
    expect((await fremd.skill.execute(AG_EINGABE, imChange)).error).toContain('sqllnx02: Zugang zeigt auf Knoten sqllnx01');
    const halb = voll({ [LINUX_HA_BAUSTEINE.status]: [STATUS_3[0], statusAg('sqllnx02', '2', { cluster: { ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, online: ['sqllnx01', 'sqllnx02'] } } }), STATUS_3[2]] });
    expect((await halb.skill.execute(AG_EINGABE, imChange)).error).toContain('2/3 online');
    expect([...fremd.aufrufe, ...halb.aufrufe].filter(a => AG_SCHRITTE.includes(a.baustein))).toEqual([]);
  });

  it('Ablauf: Status ×3 → Endpunkt ×3 → Replikat Primär, Sekundär, Konfig → Abschluss; Geheimnisse nur über stdin; Tresor nach dem Setzen', async () => {
    const w = voll();
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.map(a => `${a.baustein}@${a.zugang}`)).toEqual([
      ...['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => `${LINUX_HA_BAUSTEINE.status}@${z}`),
      ...['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => `${LINUX_HA_BAUSTEINE.agEndpunkt}@${z}`),
      ...['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => `${LINUX_HA_BAUSTEINE.agReplikat}@${z}`),
      `${LINUX_HA_BAUSTEINE.agAbschluss}@sqllnx01`,
    ]);
    const besetzung = { primaer: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg' };
    const ep = w.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agEndpunkt);
    expect(ep.map(a => a.parameter)).toEqual(['primaer', 'sekundaer', 'konfig'].map(rolle => ({ cluster: 'sqllnxcl01', ag: 'sqllnxag01', besetzung, rolle, knoten: HA_KNOTEN })));
    expect(ep[0]!.timeoutMs).toBe(180_000);
    // Kennwörter: sa je Knoten, ein Pacemaker-Kennwort für alle, Master-Key je Knoten — neu erzeugt und nach dem Lauf im Tresor
    const pm = w.tresor.get('sqllnx-ha-pacemaker')!;
    expect(pm).toHaveLength(24);
    for (const [i, z] of ['sqllnx01', 'sqllnx02', 'sqllnxcfg'].entries()) {
      const e = JSON.parse(ep[i]!.eingabe!) as Record<string, string>;
      expect(Object.keys(e).sort()).toEqual(['hauptschluessel', 'login', 'pacemaker', 'sa']);
      expect(e.sa).toBe((AG_TRESOR as Record<string, string>)[`sqllnx-${z}-sa`]);
      expect(e.pacemaker).toBe(pm);
      expect(e.hauptschluessel).toBe(w.tresor.get(`sqllnx-${z}-masterkey`));
    }
    expect(new Set(['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => w.tresor.get(`sqllnx-${z}-masterkey`))).size).toBe(3);
    expect(w.gesetzt.map(g => g.name).sort()).toEqual(['sqllnx-ha-pacemaker', 'sqllnx-sqllnx01-masterkey', 'sqllnx-sqllnx02-masterkey', 'sqllnx-sqllnxcfg-masterkey']);
    const rp = w.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agReplikat);
    for (const a of [...rp, ...w.aufrufe.filter(x => x.baustein === LINUX_HA_BAUSTEINE.agAbschluss)]) expect(Object.keys(JSON.parse(a.eingabe!))).toEqual(['sa', 'login']);
    // K1: alle drei Replikat-Läufe bekommen die Datenbanken (Primär prüft Bereitschaft, Sekundär entfernt eine alte RESTORING-Kopie)
    expect(rp.map(a => [a.zugang, (a.parameter as { rolle: string }).rolle, (a.parameter as { datenbanken: unknown }).datenbanken]))
      .toEqual([['sqllnx01', 'primaer', ['alfredpruef']], ['sqllnx02', 'sekundaer', ['alfredpruef']], ['sqllnxcfg', 'konfig', ['alfredpruef']]]);
    const ab = w.aufrufe.find(a => a.baustein === LINUX_HA_BAUSTEINE.agAbschluss)!;
    expect(ab.parameter).toEqual({ ag: 'sqllnxag01', besetzung, knoten: HA_KNOTEN, datenbanken: ['alfredpruef'], vip: { ip: '10.203.30.13', praefix: 27 } });
    expect(ab.timeoutMs).toBe(900_000);
    const geheim = [...w.tresor.values()];
    for (const a of w.aufrufe) for (const g of geheim) { expect(JSON.stringify(a.parameter)).not.toContain(g); expect(a.zweck).not.toContain(g); }
    for (const g of geheim) expect(JSON.stringify(r)).not.toContain(g);
    expect(r.display).toBe('✅ Verfügbarkeitsgruppe sqllnxag01 (CLUSTER_TYPE EXTERNAL): Primär sqllnx01, sqllnx02 SYNCHRONOUS_COMMIT (alfredpruef SYNCHRONIZED), sqllnxcfg CONFIGURATION_ONLY; '
      + 'REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT 0 in SQL und Ressource ag_cluster; Sicherungsvorgabe PRIMARY; VIP 10.203.30.13/27 auf sqllnx01 (Promoted sqllnx01) — geändert: '
      + 'sqllnx01: zertifikat, endpunkt, pacemaker-login, pacemaker-zugangsdatei; sqllnx02: zertifikat, endpunkt, pacemaker-login, pacemaker-zugangsdatei; sqllnxcfg: zertifikat, endpunkt, pacemaker-login, pacemaker-zugangsdatei; '
      + 'sqllnx01: ag-angelegt; sqllnx02: beigetreten; sqllnxcfg: beigetreten; sqllnx01: db-alfredpruef, ressource-ag, ressource-vip, kolokation, reihenfolge, vip-aktiviert');
  });

  it('nur öffentliche Zertifikate verlassen einen Knoten: jeder Knoten bekommt genau die beiden fremden Endpunkt-Zertifikate; alles andere bricht vor dem Austausch ab', async () => {
    const w = voll();
    await w.skill.execute(AG_EINGABE, imChange);
    const rp = w.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agReplikat);
    for (const a of rp) {
      const p = a.parameter as { besetzung: unknown; rolle: string; peers: Array<{ name: string; zertifikat: string; fingerabdruck: string }> };
      const ich = a.zugang;
      expect(p.peers.map(x => x.name)).toEqual(HA_KNOTEN.map(k => k.name).filter(n => n !== ich));
      for (const x of p.peers) expect(x).toEqual({ name: x.name, zertifikat: ZERT[x.name], fingerabdruck: FP[x.name] });
      expect(JSON.stringify(p)).not.toContain(ZERT[ich]!);
    }
    // ein Endpunkt-Ergebnis, das kein einzelnes DER-Zertifikat ist (z. B. PVK-Blob, PEM mit privatem Schlüssel, Länge passt nicht), wird nie weitergegeben
    for (const boese of ['1EF1B5B000000000', '-----BEGIN PRIVATE KEY-----', `${zert('A1')}00`, '30820010AB', zert('A1').toLowerCase().replace('3082', '3083')]) {
      const v = voll({ [LINUX_HA_BAUSTEINE.agEndpunkt]: [endpunkt('sqllnx01'), { ...endpunkt('sqllnx02'), zertifikat: boese }, endpunkt('sqllnxcfg')] });
      const r = await v.skill.execute(AG_EINGABE, imChange);
      expect(r.success).toBe(false);
      expect(r.error).toContain('sqllnx02 lieferte kein öffentliches Endpunkt-Zertifikat');
      expect(v.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agReplikat)).toEqual([]);
    }
  });

  it('required_synchronized_secondaries_to_commit muss an beiden Stellen 0 sein; zweiter Lauf „nichts zu tun“ ohne Tresor-Schreiben', async () => {
    for (const [feld, wert] of [['requiredSyncRessource', '1'], ['requiredSyncSql', 1], ['requiredSyncRessource', undefined], ['clusterTyp', 'WSFC']] as const) {
      const v = voll({ [LINUX_HA_BAUSTEINE.agAbschluss]: [{ ...ABSCHLUSS, [feld]: wert }] });
      const r = await v.skill.execute(AG_EINGABE, imChange);
      expect(r.success, feld).toBe(false);
      expect(r.error).toContain('Selbstprüfung');
    }
    const tresor = { ...AG_TRESOR, 'sqllnx-ha-pacemaker': 'Pm-Wert-4444', 'sqllnx-sqllnx01-masterkey': 'Mk-1', 'sqllnx-sqllnx02-masterkey': 'Mk-2', 'sqllnx-sqllnxcfg-masterkey': 'Mk-3' };
    const w = voll({
      [LINUX_HA_BAUSTEINE.agEndpunkt]: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(k => endpunkt(k, 'schon')),
      [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer', 'schon'), replikat('sqllnx02', 'sekundaer', 'schon'), replikat('sqllnxcfg', 'konfig', 'schon')],
      [LINUX_HA_BAUSTEINE.agAbschluss]: [{ ...ABSCHLUSS, zustand: 'schon', aenderungen: [] }],
    }, tresor);
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toMatch(/^Verfügbarkeitsgruppe sqllnxag01 \(CLUSTER_TYPE EXTERNAL\): Primär sqllnx01, .* — nichts zu tun$/);
    expect(w.gesetzt).toEqual([]);
    expect(JSON.parse(w.aufrufe.find(a => a.baustein === LINUX_HA_BAUSTEINE.agEndpunkt)!.eingabe!)).toEqual({ sa: 'Sa-Eins-1111', login: 'sa', hauptschluessel: 'Mk-1', pacemaker: 'Pm-Wert-4444' });
  });

  it('Kennwörter: Master-Key bzw. Pacemaker-Login gesetzt (Marke) → im Tresor, auch wenn der Lauf danach scheitert; ohne sa-Eintrag kein Fernaufruf; Meldungen geschwärzt', async () => {
    const f = voll({ [LINUX_HA_BAUSTEINE.agEndpunkt]: [{ code: 1, stdout: 'ALFRED-MASTERKEY-GESETZT\nALFRED-PACEMAKER-GESETZT\nALFRED-HA {"zustand":"fehler","fehler":"Endpunkt: Port 5022 belegt"}' }] });
    const r = await f.skill.execute(AG_EINGABE, imChange);
    expect(r.error).toContain('Port 5022 belegt');
    expect(f.gesetzt.map(g => g.name).sort()).toEqual(['sqllnx-ha-pacemaker', 'sqllnx-sqllnx01-masterkey']);
    const vorher = voll({ [LINUX_HA_BAUSTEINE.agEndpunkt]: [{ zustand: 'fehler', fehler: 'Master-Key in master besteht mit anderem Kennwort' }] });
    await vorher.skill.execute(AG_EINGABE, imChange);
    expect(vorher.gesetzt).toEqual([]);
    const { 'sqllnx-sqllnx02-sa': _weg, ...ohneSa } = AG_TRESOR;
    const o = voll({}, ohneSa);
    expect((await o.skill.execute(AG_EINGABE, imChange)).error).toContain('sqllnx-sqllnx02-sa fehlt');
    expect(o.aufrufe.filter(a => AG_SCHRITTE.includes(a.baustein))).toEqual([]);
    const g = voll({ [LINUX_HA_BAUSTEINE.agReplikat]: [{ code: 1, stdout: 'ALFRED-HA {"zustand":"fehler","fehler":"Login mit Sa-Zwei-2222 abgelehnt"}' }] });
    expect((await g.skill.execute(AG_EINGABE, imChange)).error).toContain('Login mit [geschwärzt] abgelehnt');
  });

  it('Parameter: Besetzung nur aus den festen Knoten (Konfig = sqllnxcfg), Datenbanken Pflicht und gültig, VIP — Fehler vor jedem Fernaufruf; Planprüfung', async () => {
    const w = voll();
    const fehler = async (x: Record<string, unknown>) => (await w.skill.execute({ ...AG_EINGABE, ...x }, imChange)).error;
    expect(await fehler({ datenbanken: [] })).toContain('datenbanken');
    expect(await fehler({ datenbanken: ['master'] })).toContain('datenbanken');
    expect(await fehler({ datenbanken: ["x'; DROP"] })).toContain('datenbanken');
    expect(await fehler({ sekundaer: 'sqllnx01' })).toContain('verschieden');
    expect(await fehler({ konfig: 'sqllnx02', sekundaer: 'sqllnxcfg' })).toContain('konfig: sqllnxcfg');
    expect(await fehler({ zugang: 'sqllnx09' })).toContain('sqllnx01, sqllnx02');
    expect(await fehler({ vip: '10.203.30.13' })).toContain('vip');
    expect(await fehler({ ag: 'ag; drop' })).toContain('ag:');
    expect(w.aufrufe).toEqual([]);
    expect(w.skill.pruefeEingabe(AG_EINGABE)).toBeUndefined();
    expect(w.skill.pruefeEingabe({ ...AG_EINGABE, datenbanken: undefined })).toContain('datenbanken');
    expect(w.skill.pruefeEingabe({ action: 'ag_entfernen', zugang: 'sqllnx01' })).toBeUndefined();
    expect(w.skill.mindestZeitlimitS('ag_anlegen')).toBe(LINUX_HA_MIN_ZEITLIMIT_S.ag_anlegen);
    expect(LINUX_HA_MIN_ZEITLIMIT_S.ag_anlegen).toBe(3 * 90 + 3 * 180 + 3 * 240 + 900 + 10 * 60);
    expect(LINUX_HA_MIN_ZEITLIMIT_S.ag_entfernen).toBe(3 * 300 + 3 * 60);
  });

  it('ag_entfernen: Primär zuerst (Pacemaker-Ressourcen, AG), dann Sekundär und Konfig; nur sa über stdin; Datenbanken bleiben (Text nennt RESTORING)', async () => {
    const ent = (k: string, zustand = 'geaendert') => ({ zustand, knoten: k, datenbanken: k === 'sqllnx01' ? [{ name: 'alfredpruef', zustand: 'ONLINE' }] : k === 'sqllnx02' ? [{ name: 'alfredpruef', zustand: 'RESTORING' }] : [], aenderungen: zustand === 'schon' ? [] : ['ag-entfernt', 'endpunkt-entfernt'] });
    const w = welt({ [LINUX_HA_BAUSTEINE.agEntfernen]: [ent('sqllnx01'), ent('sqllnx02'), ent('sqllnxcfg'), ent('sqllnx01', 'schon'), ent('sqllnx02', 'schon'), ent('sqllnxcfg', 'schon')] }, AG_TRESOR);
    expect((await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01', ag: 'sqllnxag01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.map(a => [a.zugang, (a.parameter as { rolle: string; ressourcen: boolean }).rolle, (a.parameter as { ressourcen: boolean }).ressourcen])).toEqual([['sqllnx01', 'primaer', true], ['sqllnx02', 'sekundaer', false], ['sqllnxcfg', 'konfig', false]]);
    expect(w.aufrufe.every(a => Object.keys(JSON.parse(a.eingabe!)).join() === 'sa,login')).toBe(true);
    expect(w.aufrufe[0]!.timeoutMs).toBe(300_000);
    expect(r.display).toBe('✅ Verfügbarkeitsgruppe sqllnxag01 entfernt (Pacemaker-Ressourcen ag_cluster/ag_vip, AG, Endpunkte, Endpunkt-Zertifikate, Pacemaker-Login und Zugangsdatei; Master-Keys bleiben); Datenbanken bleiben: sqllnx01 alfredpruef ONLINE; sqllnx02 alfredpruef RESTORING — geändert: sqllnx01: ag-entfernt, endpunkt-entfernt; sqllnx02: ag-entfernt, endpunkt-entfernt; sqllnxcfg: ag-entfernt, endpunkt-entfernt');
    expect((await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01' }, imChange)).display).toContain('— nichts zu tun');
  });
});

describe('I8e Paket 2 Task 5 Fix-Runde 1 — Abbruch mittendrin nennt alles bisher Geänderte (I1)', () => {
  const voll = (extra: Record<string, unknown[]> = {}) => welt({
    [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[],
    [LINUX_HA_BAUSTEINE.agEndpunkt]: [endpunkt('sqllnx01'), endpunkt('sqllnx02'), endpunkt('sqllnxcfg')],
    [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer'), replikat('sqllnx02', 'sekundaer'), replikat('sqllnxcfg', 'konfig')],
    [LINUX_HA_BAUSTEINE.agAbschluss]: [ABSCHLUSS],
    ...extra as Record<string, never[]>,
  }, AG_TRESOR);

  it('ag_anlegen: Replikat auf sqllnx02 scheitert → Fehler nennt die Änderungen der Endpunkt-Läufe und des Primärs, neue Tresor-Einträge; protokolliert', async () => {
    const w = voll({ [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer'), { zustand: 'fehler', fehler: 'Replikat (sekundaer) auf sqllnx02: JOIN scheitert — bisher geändert: login-sqllnx01' }] });
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('JOIN scheitert — bisher geändert: login-sqllnx01');
    expect(r.error).toContain('— vorherige Läufe bisher geändert: sqllnx01: zertifikat, endpunkt, pacemaker-login, pacemaker-zugangsdatei; sqllnx02: zertifikat, endpunkt');
    expect(r.error).toContain('sqllnx01: ag-angelegt');
    expect(r.error).toContain('neu im Tresor: sqllnx-sqllnx01-masterkey, sqllnx-ha-pacemaker, sqllnx-sqllnx02-masterkey, sqllnx-sqllnxcfg-masterkey');
    const p = w.protokolle.find(x => x.msg === 'I8e Verfügbarkeitsgruppe anlegen abgebrochen');
    expect(p?.daten).toMatchObject({ zugang: 'sqllnx01', tresorNeu: ['sqllnx-sqllnx01-masterkey', 'sqllnx-ha-pacemaker', 'sqllnx-sqllnx02-masterkey', 'sqllnx-sqllnxcfg-masterkey'] });
    expect((p!.daten.laeufe as unknown[]).length).toBe(4);
    for (const g of [...w.tresor.values()]) expect(JSON.stringify([r, w.protokolle])).not.toContain(g);
  });
  it('ag_anlegen: eigene Selbstprüfung scheitert nach allen Läufen → Fehler nennt alle zehn Läufe mit Änderungen', async () => {
    const r = await voll({ [LINUX_HA_BAUSTEINE.agAbschluss]: [{ ...ABSCHLUSS, requiredSyncRessource: '1' }] }).skill.execute(AG_EINGABE, imChange);
    expect(r.error).toContain('Selbstprüfung der Verfügbarkeitsgruppe');
    expect(r.error).toContain('sqllnx01: db-alfredpruef, ressource-ag, ressource-vip, kolokation, reihenfolge, vip-aktiviert');
  });
  it('ag_anlegen: Fencing-Gate → „vorherige Läufe bisher geändert: nichts“; ag_entfernen: Abbruch auf sqllnx02 nennt das auf dem Primär Entfernte', async () => {
    const st = [...STATUS_3]; st[1] = statusAg('sqllnx02', '2', { fencing: undefined }) as never;
    const g = await voll({ [LINUX_HA_BAUSTEINE.status]: st }).skill.execute(AG_EINGABE, imChange);
    expect(g.error).toMatch(/^Verfügbarkeitsgruppe anlegen abgebrochen — Grund: Verfügbarkeitsgruppe sqllnxag01 nicht angelegt — .* keine SQL-Zeile ausgeführt, nichts geändert — vorherige Läufe bisher geändert: nichts$/);
    expect(g.data).toBeUndefined(); // nichts geändert → keine Daten (der Motor markiert den Schritt sonst als „teilweise“)
    const w = welt({ [LINUX_HA_BAUSTEINE.agEntfernen]: [{ zustand: 'geaendert', knoten: 'sqllnx01', datenbanken: [{ name: 'alfredpruef', zustand: 'ONLINE' }], aenderungen: ['ressource-vip-entfernt', 'ressource-ag-entfernt', 'ag-entfernt'] },
      { zustand: 'fehler', fehler: 'Endpunkt auf sqllnx02 nicht entfernbar' }] }, AG_TRESOR);
    const r = await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.error).toBe('Verfügbarkeitsgruppe entfernen abgebrochen — Grund: AG entfernen sqllnx02 auf sqllnx02 gescheitert (Exit 1): Endpunkt auf sqllnx02 nicht entfernbar — vorherige Läufe bisher geändert: sqllnx01: ressource-vip-entfernt, ressource-ag-entfernt, ag-entfernt');
    expect(r.data).toMatchObject({ abgebrochen: 'Verfügbarkeitsgruppe entfernen', laeufe: [{ knoten: 'sqllnx01', zustand: 'geaendert', aenderungen: ['ressource-vip-entfernt', 'ressource-ag-entfernt', 'ag-entfernt'] }], tresorNeu: [] });
    expect(w.protokolle.some(x => x.msg === 'I8e Verfügbarkeitsgruppe entfernen abgebrochen')).toBe(true);
  });
});

describe('I8e Paket 2 Task 5 Fix-Runde 2 — Spur übersteht die Kürzung, abgewiesenes Zertifikat zählt mit (A1, A2)', () => {
  // realistische Änderungslisten (wie die Bausteine sie melden)
  const EP_AE = ['masterkey', 'pacemaker-login', 'pacemaker-view-server-state', 'zertifikat', 'endpunkt', 'pacemaker-zugangsdatei'];
  const rpAe = (k: string, rolle: string) => [...HA_KNOTEN.map(x => x.name).filter(n => n !== k).flatMap(n => [`login-${n}`, `benutzer-${n}`, `zertifikat-${n}`, `connect-${n}`]),
    ...(rolle === 'primaer' ? ['ag-angelegt'] : rolle === 'sekundaer' ? ['beigetreten', 'seeding-erlaubt'] : ['beigetreten']), 'pacemaker-ag-rechte'];
  const langerGrund = `Selbstprüfung auf sqllnx01: ${'Msg 50290, Level 16, State 1, Server sqllnx01, Line 12 Zertifikat/Benutzer/Login fehlt oder weicht ab; '.repeat(12)}`;
  const lang = (abschluss: unknown) => welt({
    [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[],
    [LINUX_HA_BAUSTEINE.agEndpunkt]: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(k => ({ ...endpunkt(k), aenderungen: EP_AE })),
    [LINUX_HA_BAUSTEINE.agReplikat]: (['sqllnx01', 'sqllnx02', 'sqllnxcfg'] as const).map(k => ({ ...replikat(k, ROLLE[k]), aenderungen: rpAe(k, ROLLE[k]) })),
    [LINUX_HA_BAUSTEINE.agAbschluss]: [abschluss as never],
  }, AG_TRESOR);
  const ROLLE = { sqllnx01: 'primaer', sqllnx02: 'sekundaer', sqllnxcfg: 'konfig' } as const;

  const SPUR_LANG = () => ['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(k => `${k}: ${EP_AE.join(', ')}`).join('; ') + '; '
    + (['sqllnx01', 'sqllnx02', 'sqllnxcfg'] as const).map(k => `${k}: ${rpAe(k, ROLLE[k]).join(', ')}`).join('; ')
    + '; neu im Tresor: sqllnx-sqllnx01-masterkey, sqllnx-ha-pacemaker, sqllnx-sqllnx02-masterkey, sqllnx-sqllnxcfg-masterkey';
  const LANG_FEHLER = () => ({ code: 1, stdout: `ALFRED-HA ${JSON.stringify({ zustand: 'fehler', fehler: `${langerGrund} — bisher geändert: db-alfredpruef,ressource-ag` })}` });

  it('A1/C: lange Änderungslisten + langer Grund — Grund (Anfang + eigene Teiländerungen) vorn in den ersten 500 Zeichen, volle Spur im Text (≤ AG_FEHLER_MAX) und als Daten', async () => {
    const r = await lang(LANG_FEHLER()).skill.execute(AG_EINGABE, imChange);
    expect(r.success).toBe(false);
    expect(SPUR_LANG().length).toBeGreaterThan(800);
    const vorn = r.error!.slice(0, 500);
    expect(vorn).toMatch(/^Verfügbarkeitsgruppe anlegen abgebrochen — Grund: AG-Abschluss sqllnx01 auf sqllnx01 gescheitert \(Exit 1\): Selbstprüfung auf sqllnx01: Msg 50290.* … .*— bisher geändert: db-alfredpruef,ressource-ag — vorherige Läufe bisher geändert: sqllnx01: masterkey/);
    expect(r.error!.endsWith(`— vorherige Läufe bisher geändert: ${SPUR_LANG()}`), r.error).toBe(true);
    expect(r.error!.length).toBeLessThanOrEqual(AG_FEHLER_MAX);
    const d = r.data as { abgebrochen: string; grund: string; laeufe: Array<{ knoten: string; aenderungen: string[] }>; tresorNeu: string[] };
    expect(d.abgebrochen).toBe('Verfügbarkeitsgruppe anlegen');
    expect(d.laeufe.map(l => `${l.knoten}: ${l.aenderungen.join(', ')}`).join('; ')).toBe(SPUR_LANG().split('; neu im Tresor')[0]);
    expect(d.tresorNeu).toEqual(['sqllnx-sqllnx01-masterkey', 'sqllnx-ha-pacemaker', 'sqllnx-sqllnx02-masterkey', 'sqllnx-sqllnxcfg-masterkey']);
    expect(d.grund).toContain(langerGrund.trim().slice(0, 300));
  });

  it('C: im Change-Motor — gescheiterter ag_anlegen-Schritt speichert den Grund in den 500 Zeichen von „fehler“ und die volle Spur in den Daten (teilweise → Rückweg ag_entfernen)', async () => {
    const w = lang(LANG_FEHLER());
    const schritt: ChangeSchritt = { nr: 1, titel: 'AG anlegen', art: 'aktion', zeitlimitS: 3100, beiFehler: 'anhalten', skill: 'linux_ha', aktion: 'ag_anlegen', einordnung: 'aendern',
      parameter: { zugang: 'sqllnx01', datenbanken: ['alfredpruef'] }, rueckweg: { skill: 'linux_ha', aktion: 'ag_entfernen', parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01' } } };
    const c: CmdbChangeRequest = { id: 'chg-ag', userId: 'o', title: 'AG', type: 'normal', status: 'approved' as never, riskLevel: 'high', affectedAssetIds: [], affectedServiceIds: [], schritte: [schritt], fingerabdruck: 'fp', freigabeFingerabdruck: 'fp', createdAt: 'x', updatedAt: 'x' };
    const deps = {
      owner: () => 'o',
      itsm: { liste: async () => [c], hole: async () => c, motorSetze: async (_o: string, _id: string, d: { status?: string; lauf?: unknown; result?: string }) => { if (d.status) c.status = d.status as never; c.lauf = JSON.parse(JSON.stringify(d.lauf)); if (d.result !== undefined) c.result = d.result; return c; } },
      fuehreAus: async (skill: string, input: Record<string, unknown>) => (skill === 'linux_ha' ? w.skill.execute(input, imChange) : { success: true }),
      fernLesen: async () => '', fernAusfuehren: async () => ({ code: 0, stdout: '', stderr: '' }),
      netz: { http: async () => ({ status: 200, text: '' }), port: async () => true, dns: async () => [], ping: async () => true },
      incident: { anlegen: async () => 'inc-1', notiz: async () => undefined, loese: async () => undefined, hochstufen: async () => undefined },
      melde: async () => undefined, frage: async () => true, schlafe: async () => undefined,
      takt: { pruefAbstandMs: 0, pruefVersuche: 1, taskAbstandMs: 0, wartenAbstandMs: 1 },
    } as unknown as MotorDeps;
    const m = new ChangeMotor(deps);
    await m.anstossen();
    for (let i = 0; i < 400 && (m.aktiv() > 0 || (c.lauf as ChangeLauf | undefined)?.phase === 'laeuft'); i++) await new Promise(r => setTimeout(r, 5));
    const l = c.lauf as ChangeLauf;
    expect(l.phase, JSON.stringify({ l, r: c.result, s: c.status }).slice(0, 1500)).toBe('angehalten');
    const e = l.ergebnisse.find(x => x.nr === 1)!;
    expect(e).toMatchObject({ ok: false, teilweise: true });
    expect(e.fehler!.length).toBeLessThanOrEqual(500);
    expect(e.fehler).toMatch(/^Verfügbarkeitsgruppe anlegen abgebrochen — Grund: AG-Abschluss sqllnx01 auf sqllnx01 gescheitert .*— bisher geändert: db-alfredpruef,ressource-ag — vorherige Läufe bisher geändert: /);
    const d = e.daten as { laeufe: Array<{ knoten: string; aenderungen: string[] }>; tresorNeu: string[] };
    expect(d.laeufe.map(x => `${x.knoten}: ${x.aenderungen.join(', ')}`).join('; ')).toBe(SPUR_LANG().split('; neu im Tresor')[0]);
    expect(d.tresorNeu).toHaveLength(4);
    expect(rueckwegSchritte([schritt], l.ergebnisse).map(s => s.nr)).toEqual([1]); // Teiländerungen → ag_entfernen gehört in den Rückweg
    for (const g of [...w.tresor.values()]) expect(JSON.stringify(l)).not.toContain(g);
  });
  it('A2: Endpunkt meldet Änderungen, aber kein öffentliches Zertifikat → seine Änderungen stehen in Fehler und Protokoll', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[], [LINUX_HA_BAUSTEINE.agEndpunkt]: [{ ...endpunkt('sqllnx01'), zertifikat: '1EF1B5B000', aenderungen: EP_AE }] }, AG_TRESOR);
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.error).toContain(`vorherige Läufe bisher geändert: sqllnx01: ${EP_AE.join(', ')}`);
    expect(r.error).toContain('sqllnx01 lieferte kein öffentliches Endpunkt-Zertifikat');
    const p = w.protokolle.find(x => x.msg === 'I8e Verfügbarkeitsgruppe anlegen abgebrochen')!;
    expect(p.daten.laeufe).toEqual([{ knoten: 'sqllnx01', zustand: 'geaendert', aenderungen: EP_AE }]);
  });
});

describe('I8e Paket 2 Task 5 — Ruling R8: ändernder Lauf ohne Ergebniszeile = möglicherweise geändert (fail-closed)', () => {
  const OHNE = { code: 124, stdout: '' };
  const basis = (extra: Record<string, unknown[]>, tresor: Record<string, string> = AG_TRESOR) => welt({
    [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[],
    [LINUX_HA_BAUSTEINE.agEndpunkt]: [endpunkt('sqllnx01', 'schon'), endpunkt('sqllnx02', 'schon'), endpunkt('sqllnxcfg', 'schon')],
    [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer', 'schon'), replikat('sqllnx02', 'sekundaer', 'schon'), replikat('sqllnxcfg', 'konfig', 'schon')],
    [LINUX_HA_BAUSTEINE.agAbschluss]: [{ ...ABSCHLUSS, zustand: 'schon', aenderungen: [] }],
    ...extra as Record<string, never[]>,
  }, tresor);
  const ALLE_DA = { ...AG_TRESOR, 'sqllnx-ha-pacemaker': 'Pm-Wert-4444', 'sqllnx-sqllnx01-masterkey': 'Mk-1', 'sqllnx-sqllnx02-masterkey': 'Mk-2', 'sqllnx-sqllnxcfg-masterkey': 'Mk-3' };

  it('ag_anlegen: Endpunkt-Lauf auf sqllnx02 endet mit Exit 124 ohne Ausgabe (nichts vorher geändert) → „möglicherweise geändert“, Daten gesetzt', async () => {
    const w = basis({ [LINUX_HA_BAUSTEINE.agEndpunkt]: [endpunkt('sqllnx01', 'schon'), OHNE] }, ALLE_DA);
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('AG-Endpunkt sqllnx02 auf sqllnx02 gescheitert (Exit 124): keine Ausgabe — möglicherweise geändert: kein Ergebnis des Endpunkt-Bausteins');
    expect(r.error).toContain('vorherige Läufe bisher geändert: nichts');
    expect(r.data).toMatchObject({ abgebrochen: 'Verfügbarkeitsgruppe anlegen', tresorNeu: [] });
  });
  it('ag_anlegen: Replikat- und Abschluss-Lauf ohne Ergebniszeile → ebenso; neues Kennwort eines Endpunkt-Laufs ohne Ergebnis kommt in den Tresor', async () => {
    const faelle: Array<Record<string, unknown[]>> = [{ [LINUX_HA_BAUSTEINE.agReplikat]: [replikat('sqllnx01', 'primaer', 'schon'), OHNE] }, { [LINUX_HA_BAUSTEINE.agAbschluss]: [{ code: 137, stdout: 'irgendwas\n' }] }];
    for (const extra of faelle) {
      const r = await basis(extra, ALLE_DA).skill.execute(AG_EINGABE, imChange);
      expect(r.error).toContain('möglicherweise geändert: kein Ergebnis des');
      expect(r.data).toBeDefined();
    }
    const n = basis({ [LINUX_HA_BAUSTEINE.agEndpunkt]: [OHNE] });
    const r = await n.skill.execute(AG_EINGABE, imChange);
    expect(r.error).toContain('möglicherweise geändert');
    expect(n.gesetzt.map(g => g.name).sort()).toEqual(['sqllnx-ha-pacemaker', 'sqllnx-sqllnx01-masterkey']);
  });
  it('ag_entfernen: Lauf ohne Ergebniszeile → „möglicherweise geändert“, Daten gesetzt', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.agEntfernen]: [OHNE] }, AG_TRESOR);
    const r = await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.error).toContain('AG entfernen sqllnx01 auf sqllnx01 gescheitert (Exit 124): keine Ausgabe — möglicherweise geändert: kein Ergebnis des Entfernen-Bausteins');
    expect(r.data).toMatchObject({ abgebrochen: 'Verfügbarkeitsgruppe entfernen', laeufe: [] });
  });
  it('lesender Lauf (Status im Gate) ohne Ergebniszeile bleibt „nichts geändert“ ohne Daten', async () => {
    const w = basis({ [LINUX_HA_BAUSTEINE.status]: [OHNE] });
    const r = await w.skill.execute(AG_EINGABE, imChange);
    expect(r.error).toContain('HA-Status vor dem AG-Aufbau auf sqllnx01 gescheitert (Exit 124)');
    expect(r.error).not.toContain('möglicherweise geändert');
    expect(r.data).toBeUndefined();
    expect(w.aufrufe.filter(a => a.baustein !== LINUX_HA_BAUSTEINE.status)).toEqual([]);
  });
});

describe('I8e Paket 2 Final-Review I-1 — Teiländerungen auch bei ha_vorbereiten, cluster_anlegen, cluster_entfernen, fencing_pruefen', () => {
  const KW = 'Hk-Tresor-Wert-77';
  const OHNE = { code: 124, stdout: '' };
  const fehler = (f: string) => ({ code: 1, stdout: `irgendwas\nALFRED-HA ${JSON.stringify({ zustand: 'fehler', baustein: 'x', fehler: f })}\n` });
  const FAELLE = [
    { action: 'ha_vorbereiten', baustein: LINUX_HA_BAUSTEINE.vorbereiten, eingabe: { zugang: 'sqllnx01', rolle: 'daten' }, was: 'HA-Grundlage vorbereiten', zweck: 'HA-Grundlage vorbereiten', hinweis: 'des Vorbereiten-Bausteins',
      nach: 'SQL Server lauscht nach dem Neustart nicht auf 1433 (120 s) — bisher geändert: pakete,halten:pcs,firewall-regeln,hadr', vor: 'kein i6300ESB-Watchdog (PCI 8086:25ab) in der VM — nichts geändert' },
    { action: 'cluster_anlegen', baustein: LINUX_HA_BAUSTEINE.cluster, eingabe: { zugang: 'sqllnx01' }, was: 'Cluster anlegen', zweck: 'Cluster anlegen', hinweis: 'des Cluster-Bausteins',
      nach: 'pcs cluster start --all fehlgeschlagen: Error: unable to start — Rückweg cluster_entfernen — bisher geändert: pcs-anmeldung,cluster-angelegt,sbd-diskless,cluster-aktiviert', vor: 'auf sqllnx02 ist ein anderer Cluster eingerichtet: altcl — am Cluster nichts geändert (nur pcs-Anmeldung erneuert)' },
    { action: 'cluster_entfernen', baustein: LINUX_HA_BAUSTEINE.clusterEntfernen, eingabe: { zugang: 'sqllnx01' }, was: 'Cluster entfernen', zweck: 'Cluster entfernen', hinweis: 'des Entfernen-Bausteins',
      nach: 'pcs stonith sbd disable fehlgeschlagen: Error: disable kaputt — Cluster ist gestoppt — bisher geändert: cluster-gestoppt', vor: 'Cluster sqllnxcl01 trägt 1 Ressourcen — vorher die Ressourcen (Verfügbarkeitsgruppe) entfernen; nichts geändert' },
    { action: 'fencing_pruefen', baustein: LINUX_HA_BAUSTEINE.fencingPruefen, eingabe: { zugang: 'sqllnx01', art: 'trennung' }, was: 'Fencing-Test', zweck: 'Fencing-Test trennung', hinweis: 'des Fencing-Tests',
      nach: 'Selbstprüfung: Auslöser alfred-fencetest-1.timer nicht aktiv — bisher geändert: fencing-test-datei,aufheben-geplant,ausloeser-geplant', vor: 'Cluster: 2/3 online — kein Test; nichts geändert' },
  ] as const;
  const lauf = (f: typeof FAELLE[number], antwort: { code: number; stdout: string }) => {
    const w = welt({ [f.baustein]: [antwort] }, { [HA_HACLUSTER_TRESOR]: KW });
    return { w, r: w.skill.execute({ action: f.action, ...f.eingabe }, imChange) };
  };

  it('Abbruch nach Änderungen („bisher geändert“ vom Baustein) → Fehler mit Grund vorn und Daten (teilweise → Rückweg); protokolliert', async () => {
    for (const f of FAELLE) {
      const { w, r: rp } = lauf(f, fehler(f.nach));
      const r = await rp;
      expect(r.success, f.action).toBe(false);
      expect(r.error!.startsWith(`${f.was} abgebrochen — Grund: ${f.zweck} auf sqllnx01 gescheitert (Exit 1): `), r.error).toBe(true);
      expect(r.error, f.action).toContain(f.nach.split(' — bisher geändert: ')[1]);
      expect(r.data, f.action).toMatchObject({ abgebrochen: f.was, laeufe: [], tresorNeu: [] });
      expect((r.data as { grund: string }).grund).toContain(`bisher geändert: ${f.nach.split(' — bisher geändert: ')[1]}`);
      expect(w.protokolle.some(p => p.msg === `I8e ${f.was} abgebrochen`), f.action).toBe(true);
      expect(JSON.stringify(r)).not.toContain(KW);
    }
  });

  it('Lauf ohne Ergebniszeile (Zeitgrenze, Verbindung weg) oder nur mit der Ersatzzeile des EXIT-Traps → „möglicherweise geändert“, Daten gesetzt', async () => {
    for (const f of FAELLE) {
      const r = await lauf(f, OHNE).r;
      expect(r.error, f.action).toContain(`${f.zweck} auf sqllnx01 gescheitert (Exit 124): keine Ausgabe — möglicherweise geändert: kein Ergebnis ${f.hinweis}`);
      expect(r.data, f.action).toMatchObject({ abgebrochen: f.was });
      const t = await lauf(f, { code: 1, stdout: 'ALFRED-HA {"zustand":"fehler","baustein":"x","fehler":"unerwarteter Abbruch (Exit 1)","alteZugangsdateienEntfernt":0}' }).r;
      expect(t.error, f.action).toContain(`unerwarteter Abbruch (Exit 1) — möglicherweise geändert: unerwartetes Ende ${f.hinweis}`);
      expect(t.data, f.action).toBeDefined();
    }
  });

  it('Abbruch vor jeder Änderung (auch: nur pcs-Anmeldung erneuert) → Fehler ohne Daten; Erfolg unverändert', async () => {
    for (const f of FAELLE) {
      const r = await lauf(f, fehler(f.vor)).r;
      expect(r.success, f.action).toBe(false);
      expect(r.error, f.action).toContain(f.vor);
      expect(r.data, f.action).toBeUndefined();
    }
  });

  it('ha_vorbereiten: neues hacluster-Kennwort gesetzt (Marke), dann Abbruch ohne Liste → Tresor-Eintrag steht in Fehler und Daten', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.vorbereiten]: [{ code: 1, stdout: 'ALFRED-HACLUSTER-GESETZT\nALFRED-HA {"zustand":"fehler","fehler":"pcsd lässt sich nicht starten — bisher geändert: hacluster-kennwort"}' }] });
    const r = await w.skill.execute({ action: 'ha_vorbereiten', zugang: 'sqllnx01', rolle: 'daten' }, imChange);
    expect(w.gesetzt.map(g => g.name)).toEqual([HA_HACLUSTER_TRESOR]);
    expect(r.error).toContain(`neu im Tresor: ${HA_HACLUSTER_TRESOR}`);
    expect(r.data).toMatchObject({ tresorNeu: [HA_HACLUSTER_TRESOR] });
    expect(JSON.stringify(r)).not.toContain(w.gesetzt[0]!.wert);
  });

  it('im Change-Motor: cluster_anlegen bricht nach setup ab → Schritt teilweise, cluster_entfernen gehört in den Rückweg', async () => {
    const w = welt({ [LINUX_HA_BAUSTEINE.cluster]: [fehler(FAELLE[1].nach)] }, { [HA_HACLUSTER_TRESOR]: KW });
    const schritt: ChangeSchritt = { nr: 1, titel: 'Cluster anlegen', art: 'aktion', zeitlimitS: 960, beiFehler: 'anhalten', skill: 'linux_ha', aktion: 'cluster_anlegen', einordnung: 'aendern',
      parameter: { zugang: 'sqllnx01' }, rueckweg: { skill: 'linux_ha', aktion: 'cluster_entfernen', parameter: { zugang: 'sqllnx01', cluster: 'sqllnxcl01' } } };
    const c: CmdbChangeRequest = { id: 'chg-cl', userId: 'o', title: 'Cluster', type: 'normal', status: 'approved' as never, riskLevel: 'high', affectedAssetIds: [], affectedServiceIds: [], schritte: [schritt], fingerabdruck: 'fp', freigabeFingerabdruck: 'fp', createdAt: 'x', updatedAt: 'x' };
    const deps = {
      owner: () => 'o',
      itsm: { liste: async () => [c], hole: async () => c, motorSetze: async (_o: string, _id: string, d: { status?: string; lauf?: unknown; result?: string }) => { if (d.status) c.status = d.status as never; c.lauf = JSON.parse(JSON.stringify(d.lauf)); if (d.result !== undefined) c.result = d.result; return c; } },
      fuehreAus: async (skill: string, input: Record<string, unknown>) => (skill === 'linux_ha' ? w.skill.execute(input, imChange) : { success: true }),
      fernLesen: async () => '', fernAusfuehren: async () => ({ code: 0, stdout: '', stderr: '' }),
      netz: { http: async () => ({ status: 200, text: '' }), port: async () => true, dns: async () => [], ping: async () => true },
      incident: { anlegen: async () => 'inc-1', notiz: async () => undefined, loese: async () => undefined, hochstufen: async () => undefined },
      melde: async () => undefined, frage: async () => true, schlafe: async () => undefined,
      takt: { pruefAbstandMs: 0, pruefVersuche: 1, taskAbstandMs: 0, wartenAbstandMs: 1 },
    } as unknown as MotorDeps;
    const m = new ChangeMotor(deps);
    await m.anstossen();
    for (let i = 0; i < 400 && (m.aktiv() > 0 || (c.lauf as ChangeLauf | undefined)?.phase === 'laeuft'); i++) await new Promise(r => setTimeout(r, 5));
    const l = c.lauf as ChangeLauf;
    expect(l.phase, JSON.stringify({ l, r: c.result, s: c.status }).slice(0, 1500)).toBe('angehalten');
    const e = l.ergebnisse.find(x => x.nr === 1)!;
    expect(e).toMatchObject({ ok: false, teilweise: true });
    expect(e.fehler).toMatch(/^Cluster anlegen abgebrochen — Grund: Cluster anlegen auf sqllnx01 gescheitert \(Exit 1\): pcs cluster start --all fehlgeschlagen.*bisher geändert: pcs-anmeldung,cluster-angelegt,sbd-diskless,cluster-aktiviert/);
    expect(rueckwegSchritte([schritt], l.ergebnisse).map(s => s.nr)).toEqual([1]);
    expect(JSON.stringify(l)).not.toContain(KW);
  });
});

describe('I8e Paket 2 Task 5 — Change „Verfügbarkeitsgruppe sqllnxag01 anlegen“', () => {
  const ha = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const windowsAd = { metadata: { name: 'windows_ad', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['status', 'dns_eintrag', 'dns_eintrag_loeschen'] }, zugang: { type: 'string' }, zone: { type: 'string' }, name: { type: 'string' }, ip: { type: 'string' },
  }, required: ['action', 'zugang'] } } };
  const ctx = { skill: (n: string) => (n === 'linux_ha' ? ha : n === 'windows_ad' ? windowsAd : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const anlegen = { titel: 'AG anlegen', art: 'aktion', skill: 'linux_ha', aktion: 'ag_anlegen', zeitlimitS: 3100,
    parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg', datenbanken: ['alfredpruef'], vip: '10.203.30.13/27' },
    rueckweg: { skill: 'linux_ha', aktion: 'ag_entfernen', parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01' } } };
  const dns = { titel: 'DNS sqllnxag01', art: 'aktion', skill: 'windows_ad', aktion: 'dns_eintrag', parameter: { zugang: 'dc01', zone: 'ad.3033.at', name: 'sqllnxag01', ip: '10.203.30.13' },
    rueckweg: { skill: 'windows_ad', aktion: 'dns_eintrag_loeschen', parameter: { zugang: 'dc01', zone: 'ad.3033.at', name: 'sqllnxag01' } }, pruefung: { typ: 'ping', ziel: '10.203.30.13' } };
  const plan = (schritte: unknown[]) => ({ titel: 'Verfügbarkeitsgruppe sqllnxag01 anlegen', begruendung: 'I8e Paket 2 Task 5', typ: 'normal', risiko: 'hoch', ausfallMinuten: 0, betroffen: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], schritte, ohneSicherungGrund: 'AG-Aufbau hat einen eigenen Rückweg (ag_entfernen), Datenbanken bleiben' });

  it('ag_anlegen mit Rückweg ag_entfernen (prüft sich selbst), danach DNS als eigener Schritt: 0 Fehler', () => {
    expect(aktionsArt('linux_ha', 'ag_anlegen')).toBe('aendern');
    expect(aktionsArt('linux_ha', 'ag_entfernen')).toBe('aendern');
    expect(pruefeChangePlan(plan([anlegen, dns]), ctx).fehler).toEqual([]);
  });
  it('Rückweg Pflicht und genau linux_ha.ag_entfernen; zeitlimitS unter der Summe der Bausteine abgewiesen; fehlende Datenbanken schon beim Planen', () => {
    const k = pruefeChangePlan(plan([{ ...anlegen, rueckweg: { keiner: 'Neuaufbau' } }]), ctx).fehler;
    expect(k.some(x => x.startsWith('Schritt 1:') && x.includes('braucht immer einen Rückweg — rueckweg linux_ha.ag_entfernen'))).toBe(true);
    const a = pruefeChangePlan(plan([{ ...anlegen, rueckweg: { skill: 'linux_ha', aktion: 'cluster_entfernen', parameter: { zugang: 'sqllnx01' } } }]), ctx).fehler;
    expect(a.some(x => x.includes('braucht als Rückweg genau linux_ha.ag_entfernen (zugang, ag), nicht linux_ha.cluster_entfernen'))).toBe(true);
    const z = pruefeChangePlan(plan([{ ...anlegen, zeitlimitS: 1800, parameter: { ...anlegen.parameter, datenbanken: [] } }]), ctx).fehler;
    expect(z.some(x => x.includes('zeitlimitS 1800 zu klein für linux_ha.ag_anlegen'))).toBe(true);
    expect(z.some(x => x.includes('datenbanken'))).toBe(true);
  });
});

describe('I8e Paket 2 — Werkzeugwahl', () => {
  it('Pacemaker, SBD, Verfügbarkeitsgruppe, Failover wählen die Infrastruktur-Kategorie', async () => {
    const { selectCategoriesOhneRueckfall } = await import('../skill-filter.js');
    const alle = new Set(['core', 'automation', 'infrastructure', 'productivity'] as never[]);
    for (const t of ['Läuft Pacemaker auf sqllnx02?', 'Ist SBD bereit?', 'Wie steht die Verfügbarkeitsgruppe?', 'Mach ein Failover', 'Was meldet linux_ha?', 'corosync Status bitte']) {
      expect([...(selectCategoriesOhneRueckfall(t, alle as never) ?? [])], t).toContain('infrastructure');
    }
  });
});

// ── Task 6: Geplantes Failover ──────────────────────────────────────────────────────────────────────────────────────────────────
const AG_LAGE: LinuxHaAg = {
  art: 'eingerichtet', ressource: true, name: 'sqllnxag01', requiredSyncRessource: '0', promoted: ['sqllnx01'], vip: ['sqllnx01'], standort: [],
  sql: { name: 'sqllnxag01', requiredSync: 0, datenbanken: 1, replikate: [
    { name: 'sqllnx01', rolle: 'PRIMARY', modus: 'SYNCHRONOUS_COMMIT', verbunden: 'CONNECTED', dbs: 1, sync: 1 },
    { name: 'sqllnx02', rolle: 'SECONDARY', modus: 'SYNCHRONOUS_COMMIT', verbunden: 'CONNECTED', dbs: 1, sync: 1 },
    { name: 'sqllnxcfg', rolle: 'SECONDARY', modus: 'CONFIGURATION_ONLY', verbunden: 'CONNECTED', dbs: 0, sync: 0 },
  ] }, sqlFehler: null,
};
const FO_ERGEBNIS = { zustand: 'geaendert', ag: 'sqllnxag01', primaer: 'sqllnx02', vorher: 'sqllnx01', dauerS: 12, vip: '10.203.30.13/27', vipAuf: 'sqllnx02', promotedAuf: 'sqllnx02',
  requiredSyncSql: 0, requiredSyncRessource: '0', altRolle: 'SECONDARY', datenbanken: [{ name: 'alfredpruef', zustand: 'SYNCHRONIZED' }], standortBedingungen: 0, aenderungen: ['failover-angestossen', 'standort-bedingung-entfernt'] };
const FO_EINGABE = { action: 'ag_failover', zugang: 'sqllnx01', ziel: 'sqllnx02' };

describe('I8e Paket 2 Task 6 — Status: AG-Teil', () => {
  it('fester Wortlaut: Promoted, VIP, required_sync Ressource/SQL, Replikate mit Sync-Zustand, offene Standort-Bedingungen; ohne AG-Daten unverändert', () => {
    expect(agText(AG_LAGE)).toBe('AG sqllnxag01: Promoted sqllnx01, VIP sqllnx01, required_sync Ressource 0 / SQL 0, Replikate sqllnx01 PRIMARY / sqllnx02 SECONDARY SYNCHRONIZED 1/1 / sqllnxcfg CONFIGURATION_ONLY CONNECTED, Standort-Bedingungen 0');
    expect(agText({ ...AG_LAGE, sql: { ...AG_LAGE.sql!, replikate: [AG_LAGE.sql!.replikate[0]!, { ...AG_LAGE.sql!.replikate[2]!, verbunden: 'DISCONNECTED' }] } })).not.toContain('sqllnxcfg CONFIGURATION_ONLY CONNECTED');
    expect(agText({ ...AG_LAGE, sql: { ...AG_LAGE.sql!, replikate: [{ ...AG_LAGE.sql!.replikate[2]!, verbunden: null }] } })).toContain('sqllnxcfg CONFIGURATION_ONLY unbekannt');
    expect(agText({ art: 'keine' })).toBe('AG nicht eingerichtet');
    expect(agText({ ...AG_LAGE, standort: [{ id: 'cli-prefer-ag_cluster-clone', rsc: 'ag_cluster-clone', knoten: 'sqllnx02', rolle: 'Promoted' }] }))
      .toContain('Standort-Bedingungen OFFEN: cli-prefer-ag_cluster-clone (sqllnx02, Promoted)');
    expect(agText({ ...AG_LAGE, standort: null })).toContain('Standort-Bedingungen unbekannt');
    expect(agText({ ...AG_LAGE, requiredSyncRessource: '1', sql: { ...AG_LAGE.sql!, requiredSync: 1 } })).toContain('required_sync Ressource 1 / SQL 1');
    expect(agText({ ...AG_LAGE, sql: { ...AG_LAGE.sql!, replikate: [{ ...AG_LAGE.sql!.replikate[1]!, sync: 0 }] } })).toContain('sqllnx02 SECONDARY NICHT SYNCHRONIZED 0/1');
    expect(agText({ ...AG_LAGE, sql: null, sqlFehler: 'Login failed' })).toContain('SQL nicht lesbar (Login failed)');
    expect(agText({ ...AG_LAGE, sql: null, sqlFehler: null })).toContain('SQL ohne Zugangsdatei');
    expect(agText({ ...AG_LAGE, promoted: null, vip: [] })).toContain('Promoted unbekannt, VIP keiner');
    // angehängt nach dem Fencing-Teil; ohne ag-Feld bleibt der Text wie bisher (Live-Prüfungen auf „3/3 online“, „Fencing belegt“ unberührt)
    const mit = linuxHaStatusText('sqllnx01', { ...STATUS_OK, cluster: CLUSTER_OK, ag: AG_LAGE });
    expect(mit).toMatch(/; Cluster sqllnxcl01: 3\/3 online, .*; Fencing nicht belegt; AG sqllnxag01: Promoted sqllnx01, /);
    expect(linuxHaStatusText('sqllnx01', STATUS_OK)).not.toContain('; AG ');
    expect(linuxHaStatusText('sqllnx01', { ...STATUS_OK, ag: { art: 'keine' } })).toBe(linuxHaStatusText('sqllnx01', STATUS_OK));
    const vorlage = FESTE_AUSGABEN['linux_ha.status']!;
    const muster = new RegExp(`^${vorlage.split(' | ')[0]!.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    expect(mit).toMatch(muster);
    for (const e of ['Standort-Bedingungen 0', 'required_sync Ressource 0 / SQL 0', 'Promoted sqllnx02', 'VIP sqllnx02', 'sqllnx02 SECONDARY SYNCHRONIZED']) expect(vorlage, e).toContain(e);
  });
});

describe('I8e Paket 2 Task 6 — Skill linux_ha: ag_failover', () => {
  const voll = (fo: Array<Record<string, unknown> | { code: number; stdout: string }> = [FO_ERGEBNIS], status = STATUS_3) => welt({
    [LINUX_HA_BAUSTEINE.status]: [...status] as never[], [LINUX_HA_BAUSTEINE.agFailover]: fo as never[],
  }, AG_TRESOR);

  it('nur im Change; Ablauf Status ×3 → Failover-Baustein auf dem Ziel (nur dessen sa über stdin); Text mit Dauer, neuem Primär und VIP-Ort', async () => {
    const w = voll();
    expect((await w.skill.execute(FO_EINGABE, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(w.aufrufe).toEqual([]);
    const r = await w.skill.execute(FO_EINGABE, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.map(a => `${a.baustein}@${a.zugang}`)).toEqual([
      ...['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => `${LINUX_HA_BAUSTEINE.status}@${z}`), `${LINUX_HA_BAUSTEINE.agFailover}@sqllnx02`,
    ]);
    const fo = w.aufrufe[3]!;
    expect(fo.parameter).toEqual({ ag: 'sqllnxag01', ziel: 'sqllnx02', vorher: 'sqllnx01', knoten: HA_KNOTEN.map(k => ({ ...k })) });
    expect(JSON.parse(fo.eingabe!)).toEqual({ sa: 'Sa-Zwei-2222', login: 'sa' });
    expect(fo.timeoutMs).toBe(600_000);
    expect(w.aufrufe.slice(0, 3).every(a => a.eingabe === undefined)).toBe(true);
    expect(r.display).toBe('✅ Geplantes Failover der Verfügbarkeitsgruppe sqllnxag01: Primär jetzt sqllnx02 (vorher sqllnx01) nach 12 s; VIP 10.203.30.13/27 auf sqllnx02 (Promoted sqllnx02); '
      + 'sqllnx01 SECONDARY (alfredpruef SYNCHRONIZED); REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT 0 in SQL und Ressource ag_cluster; keine Standort-Bedingung offen (pcs resource clear) — geändert: failover-angestossen, standort-bedingung-entfernt');
    expect(JSON.stringify(r)).not.toContain('Sa-Zwei-2222');
    expect(w.protokolle.some(p => p.msg === 'I8e Geplantes Failover' && p.daten.dauerS === 12)).toBe(true);
    const s = voll([{ ...FO_ERGEBNIS, zustand: 'schon', vorher: 'sqllnx02', dauerS: 0, aenderungen: [] }]);
    expect((await s.skill.execute(FO_EINGABE, imChange)).display).toBe('Verfügbarkeitsgruppe sqllnxag01: sqllnx02 ist schon Primär; VIP 10.203.30.13/27 auf sqllnx02 (Promoted sqllnx02); '
      + 'sqllnx01 SECONDARY (alfredpruef SYNCHRONIZED); REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT 0 in SQL und Ressource ag_cluster; keine Standort-Bedingung offen — nichts zu tun');
  });

  it('Gate vor jeder Änderung: Cluster nicht 3/3 / ohne Quorum, Corosync-Sperre aktiv, Reset ausstehend, Zugang zeigt woanders hin → nur Status gelesen, kein Failover-Baustein', async () => {
    const st = (i: number, s: unknown) => { const x = [...STATUS_3]; x[i] = s as never; return x; };
    for (const [status, grund] of [
      [st(1, statusAg('sqllnx02', '2', { cluster: { ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, online: ['sqllnx01', 'sqllnx02'] } } })), 'sqllnx02: Cluster sqllnxcl01: 2/3 online'],
      [st(0, statusAg('sqllnx01', '1', { cluster: { ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, quorum: false } } })), 'Quorum nein'],
      [st(2, statusAg('sqllnxcfg', '3', { fencing: { ...fencingOk('sqllnxcfg', '3'), sperreAktiv: true } })), 'sqllnxcfg: Corosync-Sperre alfred_fencetest AKTIV'],
      [st(1, statusAg('sqllnx02', '2', { fencing: { ...fencingOk('sqllnx02', '2'), test: { ...TEST01, knoten: 'sqllnx02', nodeid: '2', bootIdVorher: 'b-neu', zeitS: 1_795_000_100 } } })), 'sqllnx02: Fencing Test trennung ausgelöst, Reset ausstehend'],
      [st(1, statusAg('sqllnx01', '1')), 'sqllnx02: Zugang zeigt auf Knoten sqllnx01'],
      [st(0, { ...STATUS_3[0], cluster: undefined }), 'sqllnx01: Cluster unbekannt'],
      // Fix-Runde 1 (M2): unlesbar = Abbruch
      [st(1, { ...STATUS_3[1], fencing: undefined }), 'sqllnx02: Fencing-Lage (Sperre, Reset, Identität) nicht lesbar'],
      [st(2, statusAg('sqllnxcfg', '3', { fencing: { ...fencingOk('sqllnxcfg', '3'), identitaet: null } })), 'sqllnxcfg: Identität im Cluster nicht lesbar'],
      [st(0, statusAg('sqllnx01', '1', { fencing: { ...fencingOk('sqllnx01', '1'), sperreAktiv: undefined } })), 'sqllnx01: Corosync-Sperre nicht lesbar'],
    ] as Array<[typeof STATUS_3, string]>) {
      const w = voll([FO_ERGEBNIS], status);
      const r = await w.skill.execute(FO_EINGABE, imChange);
      expect(r.success, grund).toBe(false);
      expect(r.error, grund).toContain(grund);
      expect(r.error, grund).toContain('nichts geändert');
      expect(w.aufrufe.every(a => a.baustein === LINUX_HA_BAUSTEINE.status), grund).toBe(true);
      expect(r.data, grund).toBeUndefined();
    }
  });

  it('Parameter: ziel Pflicht, Datenreplikat, verschieden vom zugang (bisheriger Primär) — vor jedem Fernaufruf; ohne sa-Eintrag des Ziels kein Fernaufruf', async () => {
    for (const [e, grund] of [[{ ziel: 'sqllnxcfg' }, 'CONFIGURATION_ONLY'], [{ ziel: 'sqllnx01' }, 'verschieden'], [{ ziel: undefined }, 'ziel'], [{ zugang: 'sqllnxcfg' }, 'CONFIGURATION_ONLY']] as const) {
      const w = voll();
      const r = await w.skill.execute({ ...FO_EINGABE, ...e }, imChange);
      expect(r.error, grund).toContain(grund);
      expect(w.aufrufe).toEqual([]);
      expect(w.skill.pruefeEingabe({ ...FO_EINGABE, ...e })).toContain(grund);
    }
    expect(voll().skill.pruefeEingabe(FO_EINGABE)).toBeUndefined();
    const ohne = welt({ [LINUX_HA_BAUSTEINE.status]: [...STATUS_3] as never[] }, { 'sqllnx-sqllnx01-sa': 'x-1111' });
    expect((await ohne.skill.execute(FO_EINGABE, imChange)).error).toContain('sqllnx-sqllnx02-sa fehlt');
    expect(ohne.aufrufe).toEqual([]);
    expect(voll().skill.mindestZeitlimitS('ag_failover')).toBe(LINUX_HA_MIN_ZEITLIMIT_S.ag_failover);
    expect(LINUX_HA_MIN_ZEITLIMIT_S.ag_failover).toBe(3 * 90 + 600 + 4 * 60);
  });

  it('Selbstprüfung des Ergebnisses: Primär/Promoted/VIP nicht auf dem Ziel, required_sync ≠ 0, offene Standort-Bedingung → Fehler', async () => {
    for (const x of [{ primaer: 'sqllnx01' }, { promotedAuf: 'sqllnx01' }, { vipAuf: 'sqllnx01' }, { requiredSyncSql: 1 }, { requiredSyncRessource: '1' }, { requiredSyncRessource: undefined }, { standortBedingungen: 1 }]) {
      const r = await voll([{ ...FO_ERGEBNIS, ...x }]).skill.execute(FO_EINGABE, imChange);
      expect(r.success, JSON.stringify(x)).toBe(false);
      expect(r.error, JSON.stringify(x)).toContain('Selbstprüfung');
      expect(r.error).toContain('Geplantes Failover abgebrochen — Grund:');
      // Fix-Runde 1 (M6): der Lauf hat geändert → Daten (Change-Motor: teilweise → Rückweg)
      expect(r.data, JSON.stringify(x)).toBeDefined();
      expect((r.data as { laeufe: Array<{ aenderungen: string[] }> }).laeufe[0]!.aenderungen).toEqual(FO_ERGEBNIS.aenderungen);
    }
  });

  it('Abbruch des Bausteins nach dem Verschieben: Grund vorn, Teiländerungen als Daten (teilweise → Rückweg ag_failover zurück); vor dem Verschieben ohne Daten', async () => {
    const nach = { code: 1, stdout: 'ALFRED-HA {"zustand":"fehler","fehler":"Zeitüberschreitung: nach 120 s Promoted auf \'sqllnx01\' — Standort-Bedingung mit pcs resource clear ag_cluster-clone entfernt; bisher geändert: failover-angestossen,standort-bedingung-entfernt"}' };
    const r = await voll([nach]).skill.execute(FO_EINGABE, imChange);
    expect(r.success).toBe(false);
    expect(r.error!.startsWith('Geplantes Failover abgebrochen — Grund: Failover von sqllnx01 auf sqllnx02 gescheitert (Exit 1): Zeitüberschreitung')).toBe(true);
    expect(r.error).toContain('pcs resource clear');
    expect((r.data as { grund: string }).grund).toContain('bisher geändert: failover-angestossen');
    const vor = { code: 1, stdout: 'ALFRED-HA {"zustand":"fehler","fehler":"Ziel sqllnx02 nicht SYNCHRONIZED (0/1: alfredpruef=SYNCHRONIZING) — nichts geändert"}' };
    const v = await voll([vor]).skill.execute(FO_EINGABE, imChange);
    expect(v.error).toContain('nicht SYNCHRONIZED');
    expect(v.data).toBeUndefined();
    // Fix-Runde 1 (I1): Fehlerzeile des Traps (unerwartetes Ende nach dem move) → Daten; Lauf ohne jede Ergebniszeile → fail-closed Daten
    const trap = { code: 1, stdout: `ALFRED-HA ${JSON.stringify({ zustand: 'fehler', fehler: "unerwarteter Abbruch (Exit 143) nach pcs resource move — Promoted auf 'sqllnx01', Failover möglicherweise erfolgt; Standort-Bedingung mit pcs resource clear ag_cluster-clone entfernt; bisher geändert: failover-angestossen,standort-bedingung-entfernt" })}` };
    const t = await voll([trap]).skill.execute(FO_EINGABE, imChange);
    expect(t.error).toContain('unerwarteter Abbruch (Exit 143)');
    expect(t.error).toContain('pcs resource clear');
    expect(t.data).toBeDefined();
    const leer = await voll([{ code: 124, stdout: 'Zeitgrenze erreicht' }]).skill.execute(FO_EINGABE, imChange);
    expect(leer.error).toContain('möglicherweise geändert: kein Ergebnis des Failover-Bausteins');
    expect(leer.data).toBeDefined();
    expect((leer.data as { grund: string }).grund).toContain('Failover von sqllnx01 auf sqllnx02 gescheitert (Exit 124)');
  });
});

describe('I8e Paket 2 Task 6 — Change „Geplantes Failover sqllnxag01“', () => {
  const ha = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'linux_ha' ? ha : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const hin = { titel: 'Failover nach sqllnx02', art: 'aktion', skill: 'linux_ha', aktion: 'ag_failover', zeitlimitS: 1200,
    parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01', ziel: 'sqllnx02' }, rueckweg: { skill: 'linux_ha', aktion: 'ag_failover', parameter: { zugang: 'sqllnx02', ag: 'sqllnxag01', ziel: 'sqllnx01' } } };
  const zurueck = { ...hin, titel: 'Failover zurück nach sqllnx01', parameter: { zugang: 'sqllnx02', ag: 'sqllnxag01', ziel: 'sqllnx01' }, rueckweg: { skill: 'linux_ha', aktion: 'ag_failover', parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01', ziel: 'sqllnx02' } } };
  const status = (z: string, erwartet: string, nichtEnthalten?: string) => ({ titel: `Status ${z}`, art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang: z }, erwartet, ...(nichtEnthalten ? { nichtEnthalten } : {}) } });
  const plan = (schritte: unknown[]) => ({ titel: 'Geplantes Failover sqllnxag01', begruendung: 'I8e Paket 2 Task 6', typ: 'normal', risiko: 'hoch', ausfallMinuten: 1, betroffen: ['sqllnx01', 'sqllnx02'], schritte, ohneSicherungGrund: 'Failover ändert keine Daten, Rückweg ist das Failover zurück' });

  it('hin und zurück (prüft sich selbst) mit Status-Prüfungen aus dem festen Wortlaut: 0 Fehler', () => {
    expect(aktionsArt('linux_ha', 'ag_failover')).toBe('aendern');
    expect(pruefeChangePlan(plan([hin, status('sqllnx02', 'Promoted sqllnx02'), status('sqllnx01', 'Standort-Bedingungen 0', 'OFFEN'), zurueck, status('sqllnx01', 'Promoted sqllnx01')]), ctx).fehler).toEqual([]);
  });
  it('Rückweg Pflicht, genau linux_ha.ag_failover und zurück zum bisherigen Primär; zeitlimitS und Ziel schon beim Planen geprüft', () => {
    const k = pruefeChangePlan(plan([{ ...hin, rueckweg: { keiner: 'geht schon' } }]), ctx).fehler;
    expect(k.some(x => x.startsWith('Schritt 1:') && x.includes('braucht immer einen Rückweg — rueckweg linux_ha.ag_failover'))).toBe(true);
    const a = pruefeChangePlan(plan([{ ...hin, rueckweg: { skill: 'linux_ha', aktion: 'ag_entfernen', parameter: { zugang: 'sqllnx02' } } }]), ctx).fehler;
    expect(a.some(x => x.includes('braucht als Rückweg genau linux_ha.ag_failover'))).toBe(true);
    const g = pruefeChangePlan(plan([{ ...hin, rueckweg: { ...hin.rueckweg, parameter: { zugang: 'sqllnx01', ag: 'sqllnxag01', ziel: 'sqllnx02' } } }]), ctx).fehler;
    expect(g.some(x => x.includes('Rückweg') && x.includes('zurück zum bisherigen Primär'))).toBe(true);
    const z = pruefeChangePlan(plan([{ ...hin, zeitlimitS: 600, parameter: { ...hin.parameter, ziel: 'sqllnxcfg' } }]), ctx).fehler;
    expect(z.some(x => x.includes('zeitlimitS 600 zu klein für linux_ha.ag_failover'))).toBe(true);
    expect(z.some(x => x.includes('CONFIGURATION_ONLY'))).toBe(true);
  });
});

// Realfall 23.11. (Entwurf 2f31b31d): eigener Standby-Nachweis — der Status nennt Knoten im Standby als festes Prüfstück
describe('clusterText: Standby (23.11.)', () => {
  it('Knoten im Standby angehängt; ohne Standby unverändert', () => {
    expect(clusterText({ ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, standby: ['sqllnx02'] } })).toBe('Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s, Standby sqllnx02');
    expect(clusterText({ ...CLUSTER_OK, crm: { ...CLUSTER_OK.crm!, standby: [] } })).toBe('Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s');
  });
  it('feste Ausgaben und crm_mon-Auswertung', async () => {
    const { FESTE_AUSGABEN } = await import('./change-schritte.js');
    for (const k of ['sqllnx01', 'sqllnx02', 'sqllnxcfg']) expect(FESTE_AUSGABEN['linux_ha.status']).toContain(`Standby ${k}`);
    const { PY_CRM_FUNK } = await import('./linux-ha.js');
    expect(PY_CRM_FUNK).toContain('"standby": standby');
  });
});
