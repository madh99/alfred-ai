import { describe, it, expect } from 'vitest';
import { LinuxHaSkill, linuxHaStatusText, clusterText, fencingText, FENCING_OHNE_RUECKWEG_GRUND, LINUX_HA_MIN_ZEITLIMIT_S, type LinuxHaStatus, type LinuxHaCluster } from './linux-ha-skill.js';
import { LinuxSqlSkill } from './linux-sql-skill.js';
import { LINUX_HA_BAUSTEINE, HA_KNOTEN, HA_VERSIONEN, HA_HACLUSTER_TRESOR, type FencingBeleg, type FencingTest } from './linux-ha.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

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
  soll: SOLL, hadr: '1', sqlDienst: 'active', firewall: { tabelle: true, dienst: 'active', aktiviert: 'enabled' }, hosts: true, runtimeWatchdog: '0', sbdWartetAufWatchdog: true, pcsd: 'active', sql1433Zusatz: ['192.168.1.223'],
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
    expect(s.display).toBe('sqllnx02: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223); hosts-Block vorhanden; RuntimeWatchdog aus; sbd wartet auf Watchdog; pcsd aktiv; Cluster nicht eingerichtet; Fencing nicht belegt');
    expect((await w.skill.execute({ action: 'loeschen', zugang: 'sqllnx02' }, imChange)).error).toContain('Unbekannte Aktion');
  });

  it('Statustext: fester Wortlaut für Abweichungen; jede Form passt auf FESTE_AUSGABEN, positive Stücke stehen dort', () => {
    const v = (x: Partial<LinuxHaStatus>) => linuxHaStatusText('k', { ...STATUS_OK, ...x });
    expect(v({ watchdog: [], pciEsb: false })).toContain('Watchdog fehlt (kein i6300ESB in der VM)');
    expect(v({ watchdog: [], pciEsb: true })).toContain('Watchdog fehlt (i6300ESB in der VM, Modul nicht geladen)');
    expect(v({ watchdog: [{ geraet: 'watchdog0', kennung: 'Software Watchdog' }] })).toContain('Watchdog FREMD (watchdog0: Software Watchdog)');
    expect(v({ halter: [{ pid: 812, name: 'sbd', exe: '/usr/sbin/sbd' }] })).toContain('Watchdog i6300esb bei sbd');
    expect(v({ halter: [{ pid: 1, name: 'systemd', exe: '/usr/lib/systemd/systemd' }] })).toContain('Watchdog i6300esb BELEGT von systemd(1)');
    expect(v({ pakete: { ...STATUS_OK.pakete, pcs: { version: '0.11.8-1', gehalten: true }, sbd: { version: null, gehalten: false }, corosync: { version: SOLL.corosync, gehalten: false } } }))
      .toContain('Pakete abweichend: corosync nicht gehalten, pcs 0.11.8-1 (soll 0.11.7-1ubuntu1.1), sbd fehlt');
    expect(v({ hadr: null, hosts: false, runtimeWatchdog: '10s', pcsd: 'inactive', firewall: { tabelle: false, dienst: 'inactive', aktiviert: 'disabled' } }))
      .toBe('k: Watchdog i6300esb frei; Pakete fest; HADR aus; Firewall alfred_ha nicht geladen, Dienst inactive, disabled; hosts-Block fehlt; RuntimeWatchdog AN (10s); sbd wartet auf Watchdog; pcsd inactive; Cluster nicht eingerichtet; Fencing nicht belegt');
    expect(v({ hostsLoopback: ['127.0.1.1 sqllnx02.ad.3033.at sqllnx02'] })).toContain('hosts-Block mit eigenem Namen auf Loopback (127.0.1.1 sqllnx02.ad.3033.at sqllnx02)');
    expect(v({ sql1433Zusatz: [] })).toContain('Firewall alfred_ha aktiv (1433: Knoten);');
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
const fencingOk = (k: string, nodeid: string) => ({ bootId: 'b-neu', jetztS: 1_795_000_200, identitaet: { cluster: 'sqllnxcl01', knoten: k, nodeid, konfHash: 'h1' }, test: { ...TEST01, knoten: k, nodeid }, beleg: { ...BELEG01, knoten: k, nodeid } });
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
      expect(Object.keys(e).sort()).toEqual(['hauptschluessel', 'pacemaker', 'sa']);
      expect(e.sa).toBe((AG_TRESOR as Record<string, string>)[`sqllnx-${z}-sa`]);
      expect(e.pacemaker).toBe(pm);
      expect(e.hauptschluessel).toBe(w.tresor.get(`sqllnx-${z}-masterkey`));
    }
    expect(new Set(['sqllnx01', 'sqllnx02', 'sqllnxcfg'].map(z => w.tresor.get(`sqllnx-${z}-masterkey`))).size).toBe(3);
    expect(w.gesetzt.map(g => g.name).sort()).toEqual(['sqllnx-ha-pacemaker', 'sqllnx-sqllnx01-masterkey', 'sqllnx-sqllnx02-masterkey', 'sqllnx-sqllnxcfg-masterkey']);
    const rp = w.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agReplikat);
    for (const a of [...rp, ...w.aufrufe.filter(x => x.baustein === LINUX_HA_BAUSTEINE.agAbschluss)]) expect(Object.keys(JSON.parse(a.eingabe!))).toEqual(['sa']);
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
    expect(JSON.parse(w.aufrufe.find(a => a.baustein === LINUX_HA_BAUSTEINE.agEndpunkt)!.eingabe!)).toEqual({ sa: 'Sa-Eins-1111', hauptschluessel: 'Mk-1', pacemaker: 'Pm-Wert-4444' });
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
    expect(w.aufrufe.every(a => Object.keys(JSON.parse(a.eingabe!)).join() === 'sa')).toBe(true);
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
    expect(g.error).toContain('keine SQL-Zeile ausgeführt, nichts geändert — vorherige Läufe bisher geändert: nichts');
    const w = welt({ [LINUX_HA_BAUSTEINE.agEntfernen]: [{ zustand: 'geaendert', knoten: 'sqllnx01', datenbanken: [{ name: 'alfredpruef', zustand: 'ONLINE' }], aenderungen: ['ressource-vip-entfernt', 'ressource-ag-entfernt', 'ag-entfernt'] },
      { zustand: 'fehler', fehler: 'Endpunkt auf sqllnx02 nicht entfernbar' }] }, AG_TRESOR);
    const r = await w.skill.execute({ action: 'ag_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.error).toContain('Endpunkt auf sqllnx02 nicht entfernbar — vorherige Läufe bisher geändert: sqllnx01: ressource-vip-entfernt, ressource-ag-entfernt, ag-entfernt');
    expect(w.protokolle.some(x => x.msg === 'I8e Verfügbarkeitsgruppe entfernen abgebrochen')).toBe(true);
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
