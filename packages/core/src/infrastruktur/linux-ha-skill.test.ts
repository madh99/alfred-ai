import { describe, it, expect } from 'vitest';
import { LinuxHaSkill, linuxHaStatusText, LINUX_HA_MIN_ZEITLIMIT_S, type LinuxHaStatus } from './linux-ha-skill.js';
import { LinuxSqlSkill } from './linux-sql-skill.js';
import { LINUX_HA_BAUSTEINE, HA_KNOTEN, HA_VERSIONEN, HA_HACLUSTER_TRESOR } from './linux-ha.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

// I8e Paket 2 Task 2 — Skill linux_ha: HA-Grundlage je Knoten

interface Aufruf { zugang: string; baustein: string; parameter: unknown; eingabe?: string; timeoutMs: number; zweck: string }
const imChange = { ausChange: true } as never;

function welt(antworten: Record<string, Array<Record<string, unknown> | { code: number; stdout: string }>>, tresorDa: Record<string, string> = {}) {
  const aufrufe: Aufruf[] = [];
  const tresor = new Map<string, string>(Object.entries(tresorDa));
  const gesetzt: Array<{ name: string; wert: string; zweck: string }> = [];
  const skill = new LinuxHaSkill({
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
  return { skill, aufrufe, tresor, gesetzt };
}

const SOLL = { pacemaker: '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2', 'resource-agents-base': '1:4.13.0-1ubuntu4.2', 'mssql-server-ha': '17.0.4006.2-1' };
const STATUS_OK: LinuxHaStatus = {
  zustand: 'gelesen', watchdog: [{ geraet: 'watchdog0', kennung: 'i6300ESB timer', treiber: 'i6300esb' }], pciEsb: true, halter: [],
  pakete: { ...Object.fromEntries(Object.entries(SOLL).map(([k, v]) => [k, { version: v, gehalten: true }])), 'linux-modules-extra-6.8.0-147-generic': { version: '6.8.0-147.147', gehalten: false } },
  soll: SOLL, hadr: '1', sqlDienst: 'active', firewall: { tabelle: true, dienst: 'active', aktiviert: 'enabled' }, hosts: true, runtimeWatchdog: '0', pcsd: 'active', sql1433Zusatz: ['192.168.1.223'],
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
    expect(s.display).toBe('sqllnx02: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223); hosts-Block vorhanden; RuntimeWatchdog aus; pcsd aktiv');
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
      .toBe('k: Watchdog i6300esb frei; Pakete fest; HADR aus; Firewall alfred_ha nicht geladen, Dienst inactive, disabled; hosts-Block fehlt; RuntimeWatchdog AN (10s); pcsd inactive');
    expect(v({ hostsLoopback: ['127.0.1.1 sqllnx02.ad.3033.at sqllnx02'] })).toContain('hosts-Block mit eigenem Namen auf Loopback (127.0.1.1 sqllnx02.ad.3033.at sqllnx02)');
    expect(v({ sql1433Zusatz: [] })).toContain('Firewall alfred_ha aktiv (1433: Knoten);');
    const vorlage = FESTE_AUSGABEN['linux_ha.status']!;
    const muster = new RegExp(`^${vorlage.split(' | ')[0]!.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    for (const t of [v({}), v({ watchdog: [], pciEsb: false, hadr: '0', hosts: false })]) expect(t).toMatch(muster);
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

describe('I8e Paket 2 — Werkzeugwahl', () => {
  it('Pacemaker, SBD, Verfügbarkeitsgruppe, Failover wählen die Infrastruktur-Kategorie', async () => {
    const { selectCategoriesOhneRueckfall } = await import('../skill-filter.js');
    const alle = new Set(['core', 'automation', 'infrastructure', 'productivity'] as never[]);
    for (const t of ['Läuft Pacemaker auf sqllnx02?', 'Ist SBD bereit?', 'Wie steht die Verfügbarkeitsgruppe?', 'Mach ein Failover', 'Was meldet linux_ha?', 'corosync Status bitte']) {
      expect([...(selectCategoriesOhneRueckfall(t, alle as never) ?? [])], t).toContain('infrastructure');
    }
  });
});
