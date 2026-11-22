import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE, TLS_PRUEF_FEHLER } from './linux-sql.js';
import { tlsErzwingenSkript, pruefeTlsErzwingen, tlsEntfernenSkript, TLS_ERZWUNGEN_KOPF } from './linux-sql-tls.js';
import { PY_PM_PRUEFUNG, PY_HA_STATUS, HA_CRM_FEHLER_ARGS, HA_PM_FENSTER_S } from './linux-ha.js';
import { pacemakerFehlerText, linuxHaStatusText, type PacemakerFehler } from './linux-ha-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

// Synchrone Bash-/Python-Läufe (spawnSync) blockieren den Worker; ohne Rückgabe an die Ereignisschleife zwischen den Tests
// kommt die RPC-Antwort von vitest zu spät („Timeout calling onTaskUpdate“) — nach jedem Test einmal abgeben
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Etappe 3 Task 8 — linux_sql tls_erzwingen (network.forceencryption) mit Pacemaker-Vorbedingung

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ohneCr = (s: string) => s.replace(/\r/g, '');
const FQDN = 'sqllnx01.ad.3033.at';
const SSL_FEHLER = 'Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : SSL Provider: [error:0A000086:SSL routines::certificate verify failed:unable to get local issuer certificate].';

/** crm_mon-XML (pacemaker 2.1.6, --include=failcounts,failures) — Zeiten relativ zu jetzt, ISO mit Zeitzone */
function iso(vorS: number): string {
  const d = new Date(Date.now() - vorS * 1000);
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} +00:00`;
}
interface Xml { online?: boolean; quorum?: boolean; ag?: boolean; failcount?: string; fcZeit?: string; fehler?: Array<{ knoten: string; zeit: string; op?: string }> }
function crmXml(o: Xml = {}): string {
  const on = o.online ?? true;
  const fc = o.failcount ?? '0';
  return [
    '<pacemaker-result api-version="2.30" request="crm_mon -1 --output-as=xml --include=failcounts,failures">',
    `  <summary><current_dc present="true" name="sqllnx02" id="2" with_quorum="${o.quorum ?? true}"/><nodes_configured number="3"/><resources_configured number="4"/><cluster_options stonith-enabled="true"/></summary>`,
    '  <nodes>',
    `    <node name="sqllnx01" id="1" online="${on}" unclean="false" pending="false" type="member"/>`,
    '    <node name="sqllnx02" id="2" online="true" unclean="false" pending="false" type="member"/>',
    '    <node name="sqllnxcfg" id="3" online="true" unclean="false" pending="false" type="member"/>',
    '  </nodes>',
    '  <resources>',
    ...(o.ag ?? true ? ['    <clone id="ag_cluster-clone" multi_state="true"><resource id="ag_cluster" resource_agent="ocf:mssql:ag" role="Promoted" active="true" failed="false"><node name="sqllnx01" id="1" cached="true"/></resource></clone>'] : []),
    '    <resource id="ag_vip" resource_agent="ocf:heartbeat:IPaddr2" role="Started" active="true" failed="false"><node name="sqllnx01" id="1" cached="true"/></resource>',
    '  </resources>',
    ...(fc !== '0' ? ['  <node_history>', '    <node name="sqllnx01">', `      <resource_history id="ag_cluster" orphan="false" migration-threshold="1000000" fail-count="${fc}" last-failure="${o.fcZeit ?? iso(300)}"/>`, '    </node>', '  </node_history>'] : []),
    ...(o.fehler?.length ? ['  <failures>', ...o.fehler.map(f => `    <failure op_key="${f.op ?? 'ag_cluster_monitor_10000'}" node="${f.knoten}" exitstatus="not running" exitreason="" exitcode="7" call="12" status="complete" last-rc-change="${f.zeit}" queued="0" exec="0" interval="10000" task="monitor"/>`), '  </failures>'] : []),
    '  <status code="0" message="OK"/>',
    '</pacemaker-result>',
  ].join('\n');
}

const ORDNER: string[] = [];
afterAll(() => { for (const d of ORDNER) rmSync(d, { recursive: true, force: true }); });

// ── Python: PY_PM_PRUEFUNG direkt ────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!PYTHON)('Task 8 — Pacemaker-Fehler aus crm_mon (PY_PM_PRUEFUNG)', { timeout: 120_000 }, () => {
  function pm(xml: string, ich = 'sqllnx01'): { rc: number; f?: Record<string, unknown>; err: string } {
    const T = mkdtempSync(join(tmpdir(), 'alfred-pm-')); ORDNER.push(T);
    writeFileSync(join(T, 'crm.xml'), xml);
    const r = spawnSync(PYTHON!, ['-c', PY_PM_PRUEFUNG, ich, join(T, 'crm.xml')], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    const z = r.stdout.trim();
    return { rc: r.status ?? -1, f: z ? JSON.parse(z) as Record<string, unknown> : undefined, err: r.stderr };
  }

  it('gesund: Exit 0, Fehlerzähler 0, keine Fehlaktionen; Fenster 30 min', () => {
    const r = pm(crmXml());
    expect(r.rc, r.err).toBe(0);
    expect(r.f).toMatchObject({ knoten: 'sqllnx01', online: true, quorum: true, ressource: true, fehlerzaehler: 0, fehlaktionen: [], aeltere: 0, fensterS: 1800 });
    expect(HA_PM_FENSTER_S).toBe(1800);
    expect(HA_CRM_FEHLER_ARGS).toEqual(['-1', '--output-as=xml', '--include=failcounts,failures']);
  });

  it('Fehlerzähler > 0 mit letztem Fehler im Fenster (auch INFINITY, unlesbar) → Exit 3 mit Grund', () => {
    for (const [fc, n] of [['1', 1], ['INFINITY', 1000000], ['x', 1000000]] as const) {
      const r = pm(crmXml({ failcount: fc }));
      expect(r.rc, fc).toBe(3);
      expect(r.f?.fehlerzaehler, fc).toBe(n);
      expect(r.err, fc).toContain('Fehlerzähler ag_cluster');
      expect(r.err, fc).toContain('pcs resource cleanup ag_cluster');
    }
  });

  it('Ruling R19: Fehlerzähler mit letztem Fehler vor > 30 min sperrt nicht (nur „fehlerzaehlerAlt“); unlesbare Zeit sperrt (fail-closed)', () => {
    const alt = pm(crmXml({ failcount: '3', fcZeit: iso(3600) }));
    expect(alt.rc, alt.err).toBe(0);
    expect(alt.f).toMatchObject({ fehlerzaehler: 0, fehlerzaehlerAlt: 3 });
    const jung = pm(crmXml({ failcount: '3', fcZeit: iso(1500) }));
    expect(jung.rc).toBe(3);
    expect(jung.err).toContain('Fehlerzähler ag_cluster = 3 mit Fehler in 30 min');
    for (const z of ['', 'irgendwann']) {
      const u = pm(crmXml({ failcount: '1', fcZeit: z }));
      expect(u.rc, JSON.stringify(z)).toBe(3);
      expect(u.f?.fehlerzaehler, JSON.stringify(z)).toBe(1);
    }
  });

  it('fehlgeschlagene Aktion dieses Knotens im Fenster → Exit 3; ältere zählt nur als „aeltere“; anderer Knoten zählt nicht', () => {
    const jung = pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: iso(300) }] }));
    expect(jung.rc).toBe(3);
    expect(jung.err).toContain('1 fehlgeschlagene Aktionen in 30 min: ag_cluster_monitor_10000');
    const alt = pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: iso(3600) }] }));
    expect(alt.rc, alt.err).toBe(0);
    expect(alt.f).toMatchObject({ fehlaktionen: [], aeltere: 1 });
    const fremd = pm(crmXml({ fehler: [{ knoten: 'sqllnx02', zeit: iso(60) }] }));
    expect(fremd.rc, fremd.err).toBe(0);
    // Zeitformen: Epoche und ctime (lokal) jung → Fehler; unlesbare Zeit → zählt als jung (fail-closed)
    expect(pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: String(Math.floor(Date.now() / 1000) - 60) }] })).rc).toBe(3);
    const lokal = new Date(Date.now() - 120_000);
    const ctime = `${lokal.toLocaleString('en-US', { weekday: 'short' })} ${lokal.toLocaleString('en-US', { month: 'short' })} ${String(lokal.getDate()).padStart(2, ' ')} ${lokal.toTimeString().slice(0, 8)} ${lokal.getFullYear()}`;
    expect(pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: ctime }] })).rc, ctime).toBe(3);
    expect(pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: 'irgendwann' }] })).rc).toBe(3);
    // ISO ohne Zone, 2 h alt (lokal) → älter
    const l2 = new Date(Date.now() - 7_200_000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const isoLokal = `${l2.getFullYear()}-${p2(l2.getMonth() + 1)}-${p2(l2.getDate())} ${p2(l2.getHours())}:${p2(l2.getMinutes())}:${p2(l2.getSeconds())}`;
    expect(pm(crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: isoLokal }] })).f).toMatchObject({ aeltere: 1 });
  });

  it('Knoten offline, kein Quorum, Ressource fehlt → Exit 3; kaputtes XML → Exit 2', () => {
    expect(pm(crmXml({ online: false })).err).toContain('Knoten sqllnx01 nicht online');
    expect(pm(crmXml({ quorum: false })).err).toContain('kein Quorum');
    expect(pm(crmXml({ ag: false })).err).toContain('Ressource ag_cluster nicht gefunden');
    expect(pm('<kaputt').rc).toBe(2);
    expect(pm(crmXml(), 'sqllnx09').err).toContain('nicht online');
  });

  it('linux_ha status liest die Fehler mit eigenem crm_mon-Aufruf (Lage-Aufruf unverändert)', () => {
    expect(PY_HA_STATUS).toContain('c, x = lauf("crm_mon", "-1", "--output-as=xml")');
    expect(PY_HA_STATUS).toContain(`c, x = lauf("crm_mon", *${JSON.stringify(HA_CRM_FEHLER_ARGS)})`);
    expect(PY_HA_STATUS).toContain('cl["fehler"] = pm_fehler(x, ich, int(time.time()))');
    const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: PY_HA_STATUS, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('Task 8 — linux_ha status: Pacemaker-Fehlertext', { timeout: 120_000 }, () => {
  const gut: PacemakerFehler = { knoten: 'sqllnx01', online: true, quorum: true, ressource: true, fehlerzaehler: 0, fehlaktionen: [], aeltere: 0, fensterS: 1800 };
  it('fester Wortlaut; positives Stück in FESTE_AUSGABEN, negatives enthält FEHLER', () => {
    expect(pacemakerFehlerText(gut)).toBe('Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min)');
    expect(pacemakerFehlerText({ ...gut, aeltere: 2, fehlerzaehlerAlt: 4 })).toBe('Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min), ältere Fehlaktionen 2, älterer Fehlerzähler 4');
    expect(pacemakerFehlerText({ ...gut, fehlerzaehler: 1, fehlaktionen: [{ aktion: 'ag_cluster_monitor_10000', status: 'not_running', zeit: 1 }] }))
      .toBe('Pacemaker FEHLER: 1 Fehlaktionen in 30 min (ag_cluster_monitor_10000 not_running), Fehlerzähler ag_cluster 1 (30 min)');
    expect(pacemakerFehlerText(null)).toBe('Pacemaker-Fehler unbekannt (crm_mon nicht lesbar)');
    expect(FESTE_AUSGABEN['linux_ha.status']).toContain(' | Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min)');
    const text = linuxHaStatusText('sqllnx01', { cluster: { art: 'eingerichtet', name: 'sqllnxcl01', knoten: [], crm: { knoten: 3, online: [], quorum: true, stonith: true, ressourcen: 4 }, fehler: gut } } as never);
    expect(text).toContain('; Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min); Fencing');
    // ohne gelesene Fehler (alter Status) bleibt der Text wie bisher
    expect(linuxHaStatusText('sqllnx01', { cluster: { art: 'eingerichtet', name: 'sqllnxcl01', knoten: [], crm: null } } as never)).not.toContain('Pacemaker ohne');
  });
});

// ── Baustein ausgeführt (Stubs) ───────────────────────────────────────────────────────────────────────────────────────────────────

const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const STUBS = `python3() { PYTHONIOENCODING=utf-8 ${q(PYTHON_PFAD)} "$@" | tr -d '\\r'; }
TLS_SCHALTER="$T/etc/sqllnx-tls-pruefen"; SQLCMD="$T/sqlcmd"; sleep() { :; }
TMP_BASIS="$T/run"; CRT="$T/tls.crt"; KEY="$T/tls.key"; CA_BUNDLE="$T/bundle.crt"; CA_ISS="$T/iss.crt"; MANIFEST="$T/manifest"
MSSQLCONF="$T/mssql-conf"; MSSQL_CONF="$T/mssql.conf"
log() { printf '%s\\n' "$*" >>"$T/log"; }
openssl() { log "openssl $*"; case "$1" in x509) [ ! -f "$T/abgelaufen" ] ;; verify) if [ -f "$T/kette_kaputt" ]; then echo "error 20 at 0 depth lookup: unable to get local issuer certificate"; return 2; fi ;; esac; }
alfreds() { [ -f "$T/alfreds" ] && { [ "$1" != "$KEY" ] || [ ! -f "$T/key_fremd" ]; }; }
lies() { cat "$T/conf_$2" 2>/dev/null || true; }
hostname() { cat "$T/hostname"; }
crm_mon() { log "crm_mon $*"; if [ -f "$T/crm_kaputt" ]; then echo 'crm_mon: Error: cluster is not available on this node' >&2; return 102; fi; cat "$T/crm.xml"; }
systemctl() { case "$1" in is-active) [ -f "$T/sql_aktiv" ] ;; show) cat "$T/sql_start" ;; *) log "systemctl $*" ;; esac; }
ERZ_MARKE="$T/etc/sqllnx-tls-erzwungen"
timeout() { log "timeout $1"; shift; "$@"; }
chown() { :; }
rechte() { [ -e "$1" ] || return 0; cat "$T/marke_rechte" 2>/dev/null || echo '600 root root'; }`;

function welt(): string {
  const T = mkdtempSync(join(tmpdir(), 'alfred-tlse-')).replace(/\\/g, '/');
  ORDNER.push(T);
  for (const d of ['run', 'etc']) mkdirSync(join(T, d), { recursive: true });
  writeFileSync(join(T, 'sqlcmd'), `#!/bin/bash\n(IFS='|'; printf '%s\\n' "$*") >>"${T}/argv"\ncat >/dev/null\nif [ -f "${T}/fehler" ]; then cat "${T}/fehler"; exit 1; fi\nif [ -f "${T}/unverschluesselt" ]; then echo 'ALFRED|FALSE'; else echo 'ALFRED|TRUE'; fi\n`);
  writeFileSync(join(T, 'mssql-conf'), `#!/bin/bash\necho "mssql-conf $*" >>"${T}/mcl"\ncase "$1" in set) echo "$3" >"${T}/conf_\${2#network.}" ;; unset) rm -f "${T}/conf_\${2#network.}" ;; esac\n`);
  writeFileSync(join(T, 'tls.crt'), 'CERT'); writeFileSync(join(T, 'tls.key'), 'KEY'); writeFileSync(join(T, 'alfreds'), '');
  writeFileSync(join(T, 'conf_tlscert'), `${T}/tls.crt`); writeFileSync(join(T, 'conf_tlskey'), `${T}/tls.key`);
  writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), `${FQDN}\n`);
  writeFileSync(join(T, 'hostname'), 'sqllnx01\n');
  writeFileSync(join(T, 'crm.xml'), crmXml());
  writeFileSync(join(T, 'mssql.conf'), '');
  writeFileSync(join(T, 'sql_aktiv'), ''); writeFileSync(join(T, 'sql_start'), '@0\n');
  return T;
}
interface Lauf { rc: number; e?: Record<string, unknown>; aus: string; argv: string[]; mcl: string; log: string }
function lauf(T: string, skript: string, eingabe = '{"sa":"Sa-Geheim-1"}'): Lauf {
  for (const f of ['argv', 'mcl', 'log']) writeFileSync(join(T, f), '');
  writeFileSync(join(T, 'eingabe'), eingabe);
  const text = skript.replace('# ALFRED-ABLAUF', `${STUBS}\n# ALFRED-ABLAUF`);
  const huelle = [`T=${q(T)}`, 'chmod +x "$T/sqlcmd" "$T/mssql-conf"', 'ALFRED_EINGABE=$(cat "$T/eingabe")', `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const lies = (f: string) => ohneCr(readFileSync(join(T, f), 'utf8'));
  const aus = lies('aus');
  return { rc: Number(/RC=(\d+)/.exec(o.stdout)?.[1] ?? -1), e: sqlErgebnis(aus), aus, argv: lies('argv').split('\n').filter(Boolean), mcl: lies('mcl'), log: lies('log') };
}
const marke = (T: string) => (existsSync(join(T, 'etc', 'sqllnx-tls-erzwungen')) ? ohneCr(readFileSync(join(T, 'etc', 'sqllnx-tls-erzwungen'), 'utf8')) : undefined);
const conf = (T: string) => (existsSync(join(T, 'conf_forceencryption')) ? readFileSync(join(T, 'conf_forceencryption'), 'utf8').trim() : undefined);

describe.skipIf(!BASH || !PYTHON)('Task 8 — tls_erzwingen ausgeführt', { timeout: 120_000 }, () => {
  const an = tlsErzwingenSkript({ an: true, host: 'sqllnx01', cn: FQDN });
  const aus = tlsErzwingenSkript({ an: false });

  it('Validator, Register, Zeitlimit; Skript ohne Neustart und ohne Kennwort', () => {
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.tlsErzwingen)).toBe(true);
    expect(pruefeTlsErzwingen({ an: true, host: 'sqllnx01', cn: FQDN })).toBeUndefined();
    expect(pruefeTlsErzwingen({ an: true, host: 'sqllnxcfg', cn: 'sqllnxcfg.ad.3033.at' })).toBeUndefined();
    expect(pruefeTlsErzwingen({ an: false })).toBeUndefined();
    expect(pruefeTlsErzwingen({ an: 'ja' })).toContain('an:');
    expect(pruefeTlsErzwingen({ an: true, host: 'sql01', cn: 'sql01.ad.3033.at' })).toContain('host:');
    expect(pruefeTlsErzwingen({ an: true, host: 'sqllnx01', cn: 'sqllnx02.ad.3033.at' })).toContain('cn:');
    expect(pruefeTlsErzwingen({ an: false, host: 'sqllnx01' })).toContain('nur mit an=true');
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.tls_erzwingen).toBe(240);
    for (const s of [an, aus]) {
      expect(s).not.toMatch(/systemctl (restart|stop|start) mssql/);
      expect(s).not.toContain('Sa-Geheim');
      expect(spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' }).status).toBe(0);
    }
    expect(aus).not.toContain('crm_mon');
  });

  it('Vorbedingungen: jede fehlende → Abbruch „nicht erzwungen“, kein mssql-conf-Aufruf, forceencryption unverändert', () => {
    const faelle: Array<[string, (T: string) => void, string]> = [
      ['host', T => writeFileSync(join(T, 'hostname'), 'sqllnx02\n'), 'erwartet sqllnx01'],
      ['zert fehlt', T => rmSync(join(T, 'tls.crt')), 'fehlt — zuerst tls_einspielen'],
      ['manifest', T => rmSync(join(T, 'alfreds')), 'nicht mit diesem Inhalt in Alfreds Manifest'],
      ['schlüssel fremd', T => writeFileSync(join(T, 'key_fremd'), ''), 'tls.key steht nicht'],
      ['tlscert', T => writeFileSync(join(T, 'conf_tlscert'), '/anders.crt'), 'network.tlscert ist nicht'],
      ['tlskey', T => rmSync(join(T, 'conf_tlskey')), 'network.tlskey ist nicht'],
      ['abgelaufen', T => writeFileSync(join(T, 'abgelaufen'), ''), 'abgelaufen oder nicht lesbar'],
      ['kette', T => writeFileSync(join(T, 'kette_kaputt'), ''), 'Kette gegen den Vertrauensspeicher'],
      ['schalter fehlt', T => rmSync(join(T, 'etc', 'sqllnx-tls-pruefen')), 'zuerst tls_pruefung_schalten an=true'],
      ['schalter anderer host', T => writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), 'sqllnx02.ad.3033.at\n'), `nennt nicht ${FQDN}`],
      ['schalter ungültig', T => writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), 'evil.example.com\n'), 'ungültig'],
      ['probe tls', T => writeFileSync(join(T, 'fehler'), `${SSL_FEHLER}\n`), TLS_PRUEF_FEHLER],
      ['unverschlüsselt', T => writeFileSync(join(T, 'unverschluesselt'), ''), 'nicht verschlüsselt'],
      ['crm_mon', T => writeFileSync(join(T, 'crm_kaputt'), ''), 'crm_mon nicht lesbar'],
      ['failcount', T => writeFileSync(join(T, 'crm.xml'), crmXml({ failcount: '2' })), 'Fehlerzähler ag_cluster = 2'],
      ['vermerk fremd', T => writeFileSync(join(T, 'etc', 'sqllnx-tls-erzwungen'), 'fremd\n'), 'sqllnx-tls-erzwungen ist vorhanden und nicht von Alfred'],
      ['fehlaktion', T => writeFileSync(join(T, 'crm.xml'), crmXml({ fehler: [{ knoten: 'sqllnx01', zeit: iso(600) }] })), 'fehlgeschlagene Aktionen in 30 min'],
      ['offline', T => writeFileSync(join(T, 'crm.xml'), crmXml({ online: false })), 'nicht online'],
      ['xml kaputt', T => writeFileSync(join(T, 'crm.xml'), '<kaputt'), 'crm_mon-XML nicht lesbar'],
    ];
    for (const [name, vor, meldung] of faelle) {
      const T = welt(); vor(T);
      const r = lauf(T, an);
      expect(r.rc, `${name}: ${r.aus}`).toBe(1);
      expect(String(r.e?.fehler), name).toContain(meldung);
      expect(String(r.e?.fehler), name).toMatch(/nicht erzwungen|nichts geändert|Zertifikatsprüfung fehlgeschlagen/);
      expect(r.mcl, name).toBe('');
      expect(conf(T), name).toBeUndefined();
      // nie eine Verbindung ohne Zertifikatsprüfung
      expect(r.argv.join('\n'), name).not.toMatch(/(^|\|)-C(\||$)/m);
    }
  });

  it('alles erfüllt → forceencryption 1 (ohne Neustart), Probe -N, crm_mon mit failcounts; Wiederholung „schon“; aus = Rückweg; Wiederholung „schon“', () => {
    const T = welt();
    const r = lauf(T, an);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', erzwungen: true, fqdn: FQDN, neustartNoetig: true, vonAlfred: true, aenderungen: ['vermerk', 'mssql-conf:forceencryption'], pacemaker: { knoten: 'sqllnx01', online: true, fehlerzaehler: 0, fehlaktionen: [] } });
    expect(marke(T)).toBe(`${TLS_ERZWUNGEN_KOPF}\n`);
    expect(r.log).toContain('timeout 30');
    expect(r.mcl.trim()).toBe('mssql-conf set network.forceencryption 1');
    expect(conf(T)).toBe('1');
    expect(r.argv.length).toBeGreaterThan(0);
    for (const a of r.argv) expect(a.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]);
    expect(r.log).toContain('crm_mon -1 --output-as=xml --include=failcounts,failures');
    expect(r.log).not.toMatch(/systemctl (restart|start|stop)/);
    // wiederholt, Dienst nach der Änderung gestartet → nichts zu tun, kein Neustart nötig
    writeFileSync(join(T, 'sql_start'), '@9999999999\n');
    const w = lauf(T, an);
    expect(w.e).toMatchObject({ zustand: 'schon', erzwungen: true, neustartNoetig: false, aenderungen: [] });
    expect(w.mcl).toBe('');
    // Rückweg ohne sa, ohne Vorbedingung (auch mit kaputtem Pacemaker und ohne Schalter)
    writeFileSync(join(T, 'crm_kaputt'), ''); rmSync(join(T, 'etc', 'sqllnx-tls-pruefen'));
    const a = lauf(T, aus, '');
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', erzwungen: false, belassen: [], aenderungen: ['mssql-conf:forceencryption', 'vermerk-entfernt'] });
    expect(marke(T)).toBeUndefined();
    expect(a.mcl.trim()).toBe('mssql-conf unset network.forceencryption');
    expect(conf(T)).toBeUndefined();
    expect(a.argv).toEqual([]);
    const a2 = lauf(T, aus, '');
    expect(a2.e).toMatchObject({ zustand: 'schon', erzwungen: false });
    expect(a2.mcl).toBe('');
    // ein fremd gesetztes 0 bleibt (nicht erzwungen)
    writeFileSync(join(T, 'conf_forceencryption'), '0');
    expect(lauf(T, aus, '').mcl).toBe('');
  });

  it('Ruling R20: forceencryption 1 schon vor Alfred → an=true „schon“ ohne Vermerk; an=false lässt es stehen (belassen)', () => {
    const T = welt();
    writeFileSync(join(T, 'conf_forceencryption'), '1');
    writeFileSync(join(T, 'sql_start'), '@9999999999\n');
    const r = lauf(T, an);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', erzwungen: true, vonAlfred: false, aenderungen: [] });
    expect(marke(T)).toBeUndefined();
    expect(r.mcl).toBe('');
    const a = lauf(T, aus, '');
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'schon', erzwungen: true, aenderungen: [] });
    expect((a.e?.belassen as string[])[0]).toContain('network.forceencryption = 1 (nicht von Alfred gesetzt');
    expect(a.mcl).toBe('');
    expect(conf(T)).toBe('1');
    // ein Vermerk mit falschen Rechten zählt nicht als Alfreds — bleibt, Wert bleibt
    writeFileSync(join(T, 'etc', 'sqllnx-tls-erzwungen'), `${TLS_ERZWUNGEN_KOPF}\n`); writeFileSync(join(T, 'marke_rechte'), '644 root root');
    const f = lauf(T, aus, '');
    expect(f.mcl).toBe('');
    expect((f.e?.belassen as string[]).join(';')).toContain('(nicht von Alfred)');
    expect(marke(T)).toBeDefined();
  });

  it('tls_entfernen bleibt gesperrt, solange forceencryption 1 ist (Reihenfolge des Rückwegs)', () => {
    const T = welt();
    writeFileSync(join(T, 'conf_forceencryption'), '1');
    rmSync(join(T, 'etc', 'sqllnx-tls-pruefen'));
    const r = lauf(T, tlsEntfernenSkript(), '');
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('forceencryption = 1');
  });
});

// ── Skill und Change-Regeln ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Task 8 — Skill linux_sql tls_erzwingen, Rückweg im Change', { timeout: 120_000 }, () => {
  function skill(antwort: Record<string, unknown>) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const tresor = { namen: async () => new Set(['sqllnx-sqllnx01-sa']), lies: async () => 'Sa-Geheim-1', setze: async () => undefined };
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, parameter, eingabe) => {
        aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) });
        return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' };
      },
      tresor,
    });
    return { s, aufrufe };
  }
  const imChange = { ausChange: true } as never;
  const pmGut = { knoten: 'sqllnx01', online: true, quorum: true, ressource: true, fehlerzaehler: 0, fehlaktionen: [], aeltere: 0, fensterS: 1800 };

  it('nur im Change; Planprüfung: an Wahrheitswert, nur TLS-Hosts', async () => {
    const { s } = skill({});
    expect((await s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: true })).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(s.pruefeEingabe({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: true })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'tls_erzwingen', zugang: 'sqllnxcfg', an: true })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: 'true' })).toContain('an: true oder false');
    expect(s.pruefeEingabe({ action: 'tls_erzwingen', zugang: 'sql01', an: true })).toContain('nur auf sqllnx01, sqllnx02, sqllnxcfg');
  });

  it('an=true: sa über stdin, host/cn aus dem Zugang, Nachprüfung inkl. Pacemaker, TLS_ERZWUNGEN; an=false: ohne Tresor, TLS_NICHT_ERZWUNGEN', async () => {
    const w = skill({ zustand: 'geaendert', erzwungen: true, fqdn: FQDN, neustartNoetig: true, pacemaker: pmGut, aenderungen: ['mssql-conf:forceencryption'] });
    const r = await w.s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: true }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toMatch(/^✅ TLS_ERZWUNGEN sqllnx01: /);
    expect(r.display).toContain('Neustart von SQL Server nötig');
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_SQL_BAUSTEINE.tlsErzwingen, parameter: { an: true, host: 'sqllnx01', cn: FQDN }, eingabe: '{"sa":"Sa-Geheim-1","login":"sa"}' });
    // Pacemaker-Teil fehlt oder hat Fehler → Nachprüfung scheitert
    for (const pm of [undefined, { ...pmGut, fehlerzaehler: 1 }, { ...pmGut, fehlaktionen: [{ aktion: 'x' }] }, { ...pmGut, knoten: 'sqllnx02' }]) {
      const f = skill({ zustand: 'geaendert', erzwungen: true, fqdn: FQDN, neustartNoetig: true, ...(pm ? { pacemaker: pm } : {}) });
      expect((await f.s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: true }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    }
    const b = skill({ zustand: 'schon', erzwungen: true, belassen: ['network.forceencryption = 1 (nicht von Alfred gesetzt, kein Vermerk /etc/alfred/sqllnx-tls-erzwungen)'], neustartNoetig: false, aenderungen: [] });
    const rb = await b.s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: false }, imChange);
    expect(rb.success, rb.error).toBe(true);
    expect(rb.display).toMatch(/^TLS_ERZWUNGEN_BELASSEN sqllnx01: .*nicht von Alfred gesetzt/);
    const x = skill({ zustand: 'schon', erzwungen: true, belassen: [], neustartNoetig: false });
    expect((await x.s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: false }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    const a = skill({ zustand: 'geaendert', erzwungen: false, neustartNoetig: true, aenderungen: ['mssql-conf:forceencryption'] });
    const ra = await a.s.execute({ action: 'tls_erzwingen', zugang: 'sqllnx01', an: false }, imChange);
    expect(ra.display).toMatch(/^✅ TLS_NICHT_ERZWUNGEN sqllnx01: /);
    expect(a.aufrufe[0]).toEqual({ baustein: LINUX_SQL_BAUSTEINE.tlsErzwingen, parameter: { an: false } });
  });

  it('Change: Rückweg Pflicht, genau tls_erzwingen mit umgekehrtem an auf demselben Zugang; selbstgeprüft', () => {
    const { s: sk } = skill({});
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'TLS erzwingen sqllnx02', begruendung: 'I8e Etappe 3 L5', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx02'], ohneSicherungGrund: 'eigener Rückweg (an=false)', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (an: boolean, rueckweg?: unknown) => ({ titel: 'Erzwingen', art: 'aktion', skill: 'linux_sql', aktion: 'tls_erzwingen', parameter: { zugang: 'sqllnx02', an }, zeitlimitS: 300, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_erzwingen', parameter: { zugang: 'sqllnx02', an: false } })])).toEqual([]);
    expect(f([schritt(true, { keiner: 'x' })]).some(x => x.includes('rueckweg linux_sql.tls_erzwingen (zugang, an umgekehrt)'))).toBe(true);
    expect(f([schritt(true)]).some(x => x.includes('rueckweg fehlt'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_erzwingen', parameter: { zugang: 'sqllnx02', an: true } })]).some(x => x.includes('tls_erzwingen: rueckweg an = false'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_erzwingen', parameter: { zugang: 'sqllnx01', an: false } })]).some(x => x.includes('muss auf demselben Zugang laufen'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_entfernen', parameter: { zugang: 'sqllnx02' } })]).some(x => x.includes('braucht als Rückweg genau'))).toBe(true);
    // zu kurzes Zeitlimit
    expect(f([{ ...schritt(true, { skill: 'linux_sql', aktion: 'tls_erzwingen', parameter: { zugang: 'sqllnx02', an: false } }), zeitlimitS: 60 }]).length).toBeGreaterThan(0);
  });
});
