import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LINUX_SQL_BAUSTEINE, sqlErgebnis, STATUS_TSQL } from './linux-sql.js';
import {
  alfredLoginsAnlegenSkript, alfredLoginsEntfernenSkript, saSchaltenSkript, saKennwortSetzenSkript, ALFRED_STATUS_RECHTE, SA_MARKE_TEXT,
} from './linux-sql-logins.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8e Folge-Etappe (Spec 2026-11-22 §7.3/§7.4, Plan Task 4): Alfred-Logins anlegen/entfernen, sa schalten, sa-Kennwort setzen (Notfallweg)
afterEach(() => new Promise<void>(r => setImmediate(r)));
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const imChange = { ausChange: true } as never;

/**
 * Skript mit Stubs ausführen: sql() protokolliert „Login|T-SQL“ nach $T/sql.log und antwortet nach den Kennzeichen-Kommentaren im T-SQL;
 * Antworten liegen als Dateien in $T (admin_pruef, status_pruef, sa_pruef). systemctl/mssql-conf/crm_mon protokollieren nach $T/log.
 */
function lauf(skript: string, eingabe: Record<string, unknown>, dateien: Record<string, string> = {}) {
  const stubs = [
    `python3() { PYTHONIOENCODING=utf-8 '${PYTHON_PFAD}' "$@" | tr -d '\\r'; }`,
    'SA_SPERRE="$T/etc/sqllnx-sa-aus"; MSSQL_CONF_BIN="$T/mssql-conf"; sleep() { :; }',
    'bereit() { [ ! -f "$T/nicht_bereit" ]; }',
    'log() { printf "%s\\n" "$*" >>"$T/log"; }',
    'sql() { printf "%s|%s\\n" "$SQL_LOGIN" "$(printf "%s" "$1" | tr "\\n" " ")" >>"$T/sql.log"; case "$1" in',
    '  *ALFRED-PRUEF-ADMIN*) echo "ALFRED|$(cat "$T/admin_pruef")" ;;',
    '  *ALFRED-PRUEF-STATUS*) echo "ALFRED|$(cat "$T/status_pruef")" ;;',
    '  *ALFRED-SA-PRUEF*) echo "ALFRED|$(cat "$T/sa_pruef")" ;;',
    '  *ALFRED-LOGINS-ANLEGEN*) echo "ALFRED|angelegt|angelegt" ;;',
    '  *ALFRED-LOGINS-ENTFERNEN*) echo "ALFRED|0" ;;',
    '  *) echo "ALFRED|ok" ;; esac; }',
    'systemctl() { log "systemctl $*"; case "$1" in is-active) [ ! -f "$T/gestoppt" ] ;; stop) : >"$T/gestoppt" ;; start) if [ -f "$T/start_scheitert" ]; then rm -f "$T/start_scheitert"; return 1; fi; rm -f "$T/gestoppt" ;; esac; }',
    'hostname() { echo sqllnxcfg; }',
    'crm_mon() { log "crm_mon $*"; cat "$T/crm.xml"; }',
  ].join('\n');
  const text = skript.replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const anlegen = Object.entries(dateien).map(([n, w]) => `mkdir -p "$(dirname "$T/${n}")"; printf '%s' ${JSON.stringify(w)} >"$T/${n}"`).join('\n');
  const huelle = [
    'T=$(mktemp -d)', anlegen,
    `printf '#!/bin/bash\\necho "mssql-conf $* PW=\${MSSQL_SA_PASSWORD:+gesetzt}" >>"%s/log"\\n' "$T" >"$T/mssql-conf"; chmod +x "$T/mssql-conf"`,
    `ALFRED_EINGABE=${JSON.stringify(JSON.stringify(eingabe))}`,
    `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`,
    'echo "---AUS"; cat "$T/aus"; echo "---SQL"; cat "$T/sql.log" 2>/dev/null; echo "---LOG"; cat "$T/log" 2>/dev/null; echo "---MARKE"; cat "$T/etc/sqllnx-sa-aus" 2>/dev/null; rm -rf "$T"',
  ].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout.replace(/\r/g, '');
  const teil = (a: string, b?: string) => o.split(`---${a}\n`)[1]?.split(b ? `---${b}\n` : '\u0000')[0] ?? '';
  return { rc: Number(/RC=(\d+)/.exec(o)?.[1] ?? -1), aus: teil('AUS', 'SQL'), e: sqlErgebnis<Record<string, unknown>>(teil('AUS', 'SQL')), sql: teil('SQL', 'LOG'), log: teil('LOG', 'MARKE'), marke: teil('MARKE') };
}
const crm = (standby: boolean, aktivAufCfg = false) => `<crm_mon><nodes><node name="sqllnxcfg" id="3" online="true" standby="${standby}"/><node name="sqllnx01" id="1" online="true" standby="false"/></nodes><resources><clone id="ag_cluster-clone"><resource id="ag_cluster" role="Promoted" active="true"><node name="sqllnx01" id="1"/></resource>${aktivAufCfg ? '<resource id="ag_cluster" role="Unpromoted" active="true"><node name="sqllnxcfg" id="3"/></resource>' : '<resource id="ag_cluster" role="Stopped" active="false"/>'}</clone></resources></crm_mon>`;

describe('Bausteine registriert, Zeitlimits, Planung', () => {
  it('registriert und nur im Change; alle ändernd; Rückweg-Pflicht', () => {
    for (const b of ['alfredLoginsAnlegen', 'alfredLoginsEntfernen', 'saSchalten', 'saKennwortSetzen'] as const) expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE[b])).toBe(true);
    for (const a of ['alfred_logins_anlegen', 'alfred_logins_entfernen', 'sa_schalten', 'sa_kennwort_setzen']) {
      expect(aktionsArt('linux_sql', a)).toBe('aendern');
      expect(LINUX_SQL_MIN_ZEITLIMIT_S[a]).toBeGreaterThan(0);
    }
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'Alfred-Logins', begruendung: 'I8e Folge-Etappe N1', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'eigener Rückweg', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (aktion: string, parameter: Record<string, unknown>, rueckweg?: unknown) => ({ titel: aktion, art: 'aktion', skill: 'linux_sql', aktion, parameter: { zugang: 'sqllnx01', ...parameter }, zeitlimitS: 900, ...(rueckweg ? { rueckweg } : {}) });
    const rw = (aktion: string, parameter: Record<string, unknown> = {}) => ({ skill: 'linux_sql', aktion, parameter: { zugang: 'sqllnx01', ...parameter } });
    expect(f([schritt('alfred_logins_anlegen', {}, rw('alfred_logins_entfernen'))])).toEqual([]);
    expect(f([schritt('alfred_logins_anlegen', {}, { keiner: 'x' })]).some(x => x.includes('rueckweg linux_sql.alfred_logins_entfernen (zugang)'))).toBe(true);
    expect(f([schritt('sa_schalten', { an: false }, rw('sa_schalten', { an: true }))])).toEqual([]);
    expect(f([schritt('sa_schalten', { an: false }, rw('sa_schalten', { an: false }))]).some(x => x.includes('sa_schalten: rueckweg an = true'))).toBe(true);
    expect(f([schritt('sa_schalten', { an: 'nein' }, rw('sa_schalten', { an: true }))]).some(x => x.includes('an: true oder false'))).toBe(true);
  });
});

describe('alfred_status: jede Status-Abfrage hat ein Recht, kein Recht mehr als nötig', () => {
  it('Katalogobjekte im Status-T-SQL ↔ Rechtesatz', () => {
    const objekte = new Set((STATUS_TSQL.match(/\b(?:msdb\.dbo|tempdb\.sys|sys)\.[a-z_]+/g) ?? []));
    // je Objekt: woher das Leserecht kommt (public = Standard, sonst ein GRANT aus ALFRED_STATUS_RECHTE)
    const herkunft: Record<string, string> = {
      'sys.configurations': 'public', 'sys.databases': 'public', 'tempdb.sys.database_files': 'public',
      'sys.dm_os_sys_info': 'VIEW SERVER STATE', 'msdb.dbo.backupset': 'SELECT ON msdb.dbo.backupset', 'sys.server_principals': 'VIEW ANY DEFINITION',
    };
    for (const o of objekte) expect(herkunft[o], o).toBeDefined();
    const noetig = new Set([...objekte].map(o => herkunft[o]!).filter(h => h !== 'public'));
    expect(new Set(ALFRED_STATUS_RECHTE)).toEqual(new Set([...noetig, 'VIEW ANY DEFINITION']));
  });
});

describe.skipIf(!BASH || !PYTHON)('alfred_logins_anlegen ausgeführt', { timeout: 120_000 }, () => {
  const S = alfredLoginsAnlegenSkript({ nurNeu: true });
  const E = { sa: 'Sa-Geheim-1', login: 'sa', admin: 'Adm-Geheim-1', status: 'Sta-Geheim-1' };

  it('Skripttext: kein Kennwort, beide Logins, sysadmin nur für alfred_admin, Grants für alfred_status, nurNeu', () => {
    expect(S).not.toMatch(/Adm-Geheim|Sta-Geheim/);
    expect(S).toContain('ALTER SERVER ROLE [sysadmin] ADD MEMBER [alfred_admin]');
    expect(S).not.toContain('ADD MEMBER [alfred_status]');
    for (const g of ['GRANT VIEW ANY DEFINITION TO [alfred_status]', 'GRANT SELECT ON dbo.backupset TO [alfred_status]']) expect(S).toContain(g);
    // Review I4: kein VIEW SERVER STATE (fremde Sitzungen/SQL-Text lesbar), USE master vor den Server-Rechten, Rechte in jeder Datenbank geprüft
    expect(S).not.toContain('GRANT VIEW SERVER STATE');
    expect(S.indexOf('USE [master];')).toBeGreaterThan(-1);
    expect(S.indexOf('USE [master];')).toBeLessThan(S.indexOf('CREATE LOGIN'));
    expect(S).toContain('THROW 50008');
    expect(S).toContain('THROW 50006');
  });

  it('Erfolg: Marke für den Tresor, Selbstprüfung als alfred_admin (sysadmin) und als alfred_status (nur lesen)', () => {
    const r = lauf(S, E, { admin_pruef: '1', status_pruef: '0|0|0|0|0|1' });
    expect(r.rc, r.aus).toBe(0);
    expect(r.aus).toContain('ALFRED-LOGIN-GESETZT');
    expect(r.e).toMatchObject({ zustand: 'angelegt', admin: 'angelegt', status: 'angelegt' });
    const logins = r.sql.split('\n').filter(Boolean).map(z => z.split('|')[0]);
    expect(logins).toEqual(['sa', 'alfred_admin', 'alfred_status']);
    // Ausgabe ohne Kennwort (das Stub-Protokoll enthält das T-SQL von stdin, darum hier nur die Skriptausgabe)
    expect(r.aus).not.toMatch(/Adm-Geheim|Sta-Geheim|Sa-Geheim/);
    // Prüfungen tragen kein Kennwort im T-SQL (nur über SQLCMDPASSWORD)
    expect(r.sql.split('\n').filter(z => /ALFRED-PRUEF/.test(z)).join('\n')).not.toMatch(/Geheim/);
  });

  it('alfred_status mit mehr als Leserecht → Abbruch', () => {
    const r = lauf(S, E, { admin_pruef: '1', status_pruef: '1|1|0|0|0|1' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/alfred_status: Rechte weichen ab/);
  });

  it('alfred_admin nicht sysadmin → Abbruch', () => {
    const r = lauf(S, E, { admin_pruef: '0', status_pruef: '0|0|0|0|0|1' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/alfred_admin ist nicht sysadmin/);
  });
});

describe.skipIf(!BASH || !PYTHON)('sa_schalten ausgeführt', { timeout: 120_000 }, () => {
  const E = { sa: 'Adm-Geheim-1', login: 'alfred_admin' };

  it('an=false: sysadmin-Beleg vor DISABLE, Marke danach, Selbstprüfung', () => {
    const r = lauf(saSchaltenSkript({ an: false }), E, { sa_pruef: '1|0' });
    // nach dem DISABLE liefert der Stub weiter „1|0“ — die Selbstprüfung muss das als Fehler erkennen
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/sa ist nach DISABLE nicht abgeschaltet/);
    const z = r.sql.split('\n').filter(Boolean);
    expect(z[0]).toMatch(/^alfred_admin\|.*ALFRED-SA-PRUEF/);
    expect(z[1]).toMatch(/^alfred_admin\|.*ALTER LOGIN \[sa\] DISABLE/);
  });

  it('an=false bei schon abgeschaltetem sa: keine Änderung am Login, Marke wird gesetzt', () => {
    const r = lauf(saSchaltenSkript({ an: false }), E, { sa_pruef: '1|1' });
    expect(r.rc, r.aus).toBe(0);
    expect(r.sql).not.toContain('DISABLE');
    expect(r.marke.trim()).toBe(SA_MARKE_TEXT);
    expect(r.e).toMatchObject({ sa: 'aus' });
  });

  it('ohne sysadmin-Beleg → Abbruch ohne DISABLE und ohne Marke', () => {
    const r = lauf(saSchaltenSkript({ an: false }), E, { sa_pruef: '0|0' });
    expect(r.rc).not.toBe(0);
    expect(r.sql).not.toContain('DISABLE');
    expect(r.marke).toBe('');
  });

  it('nur als alfred_admin', () => {
    const r = lauf(saSchaltenSkript({ an: false }), { sa: 'Sa-1', login: 'sa' }, { sa_pruef: '1|0' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/nur als alfred_admin/);
    expect(r.sql).toBe('');
  });

  it('an=true: fremde Marke → Abbruch ohne Änderung', () => {
    const r = lauf(saSchaltenSkript({ an: true }), E, { sa_pruef: '1|1', 'etc/sqllnx-sa-aus': 'fremd' });
    expect(r.rc).not.toBe(0);
    expect(r.sql).not.toContain('ENABLE');
  });
});

describe.skipIf(!BASH || !PYTHON)('sa_kennwort_setzen ausgeführt', { timeout: 120_000 }, () => {
  const E = { sa: 'Sa-Geheim-1', login: 'sa' };

  it('ohne Standby → Abbruch vor dem Stoppen', () => {
    const r = lauf(saKennwortSetzenSkript(), E, { 'crm.xml': crm(false), sa_pruef: '0' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/nicht im Standby/);
    expect(r.log).not.toContain('systemctl stop');
  });

  it('mit Standby: stop → set-sa-password (Kennwort nur in der Umgebung) → start → Anmeldung als sa trotz Host-Marke', () => {
    const r = lauf(saKennwortSetzenSkript(), E, { 'crm.xml': crm(true), sa_pruef: '0', 'etc/sqllnx-sa-aus': `${SA_MARKE_TEXT}\n` });
    expect(r.rc, r.aus).toBe(0);
    const l = r.log.split('\n').filter(z => !z.startsWith('crm_mon'));
    expect(l.slice(0, 3)).toEqual(['systemctl stop mssql-server', 'mssql-conf -n set-sa-password PW=gesetzt', 'systemctl start mssql-server']);
    expect(r.sql.split('\n')[0]).toMatch(/^sa\|/);
    expect(r.e).toMatchObject({ saAbgeschaltet: false, marke: true });
    expect(r.aus + r.log + r.sql).not.toContain('Sa-Geheim-1');
  });

  it('sa nach dem Setzen nicht anmeldbar → Abbruch mit klarer Meldung', () => {
    const r = lauf(saKennwortSetzenSkript(), E, { 'crm.xml': crm(true), nicht_bereit: '' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/Anmeldung als sa nach set-sa-password gescheitert/);
    expect(r.log).toContain('systemctl start mssql-server');
  });

  it('Review I2: Standby-Attribut gesetzt, ag_cluster auf dem Knoten noch aktiv → Abbruch vor dem Stoppen', () => {
    const r = lauf(saKennwortSetzenSkript(), E, { 'crm.xml': crm(true, true), sa_pruef: '0' });
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/ag_cluster auf sqllnxcfg noch aktiv/);
    expect(r.log).not.toContain('systemctl stop');
  });

  it('Abbruch nach dem Stoppen (Start scheitert einmal) → Aufräumen startet den Dienst erneut', () => {
    const r = lauf(saKennwortSetzenSkript(), E, { 'crm.xml': crm(true), sa_pruef: '0', start_scheitert: '' });
    expect(r.rc).not.toBe(0);
    expect(r.log.split('\n').filter(z => z === 'systemctl start mssql-server')).toHaveLength(2);
  });
});

describe('Skill', () => {
  function welt(tresorDa: Record<string, string>, antwort: Record<string, unknown> = { zustand: 'angelegt', admin: 'angelegt', status: 'angelegt' }, mitEntferne = true) {
    const aufrufe: Array<{ baustein: string; eingabe?: string }> = [];
    const tresor = new Map(Object.entries(tresorDa));
    const entfernt: string[] = [];
    const skill = new LinuxSqlSkill({
      skript: async (_z, baustein, _p, eingabe) => { aufrufe.push({ baustein, eingabe }); return { code: 0, stdout: `ALFRED-LOGIN-GESETZT\nALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' }; },
      tresor: {
        namen: async () => new Set(tresor.keys()),
        lies: async n => { const w = tresor.get(n); if (w === undefined) throw new Error(`fehlt ${n}`); return w; },
        setze: async (n, w) => { tresor.set(n, w); },
        ...(mitEntferne ? { entferne: async (n: string) => { entfernt.push(n); return tresor.delete(n); } } : {}),
      },
    });
    return { skill, aufrufe, tresor, entfernt };
  }
  const SA = { 'sqllnx-sqllnx01-sa': 'Sa-1' };
  const UM = { ...SA, 'sqllnx-sqllnx01-alfred-admin': 'Adm-1', 'sqllnx-sqllnx01-alfred-status': 'Sta-1' };

  it('alfred_logins_anlegen: nur im Change; als sa, neue Kennwörter in der Eingabe, danach beide im Tresor', async () => {
    const w = welt(SA);
    expect((await w.skill.execute({ action: 'alfred_logins_anlegen', zugang: 'sqllnx01' }, {} as never)).success).toBe(false);
    const r = await w.skill.execute({ action: 'alfred_logins_anlegen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    const e = JSON.parse(w.aufrufe[0]!.eingabe!);
    expect(e.login).toBe('sa');
    expect(e.admin).toMatch(/^.{24}$/); expect(e.status).toMatch(/^.{24}$/);
    expect(w.tresor.get('sqllnx-sqllnx01-alfred-admin')).toBe(e.admin);
    expect(w.tresor.get('sqllnx-sqllnx01-alfred-status')).toBe(e.status);
  });

  it('alfred_logins_anlegen erneut: als alfred_admin, vorhandene Kennwörter, Tresor unverändert', async () => {
    const w = welt(UM, { zustand: 'schon', admin: 'schon', status: 'schon' });
    const r = await w.skill.execute({ action: 'alfred_logins_anlegen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Adm-1', login: 'alfred_admin', admin: 'Adm-1', status: 'Sta-1' });
    expect(r.display).toContain('nichts zu tun');
  });

  it('sa_schalten ohne Umstellung → Abbruch vor dem Fernaufruf; mit Umstellung als alfred_admin', async () => {
    const w1 = welt(SA);
    const r1 = await w1.skill.execute({ action: 'sa_schalten', zugang: 'sqllnx01', an: false }, imChange);
    expect(r1.success).toBe(false); expect(r1.error).toContain('zuerst alfred_logins_anlegen');
    expect(w1.aufrufe).toEqual([]);
    const w2 = welt(UM, { zustand: 'geaendert', sa: 'aus' });
    const r2 = await w2.skill.execute({ action: 'sa_schalten', zugang: 'sqllnx01', an: false }, imChange);
    expect(r2.success, r2.error).toBe(true);
    expect(JSON.parse(w2.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Adm-1', login: 'alfred_admin' });
    expect(r2.display).toContain('sa auf sqllnx01: aus');
  });

  it('sa_kennwort_setzen: liest das vorhandene sa-Kennwort, Tresor unverändert; ohne Eintrag Abbruch', async () => {
    const w = welt(UM, { zustand: 'geaendert', saAbgeschaltet: false, marke: true });
    const r = await w.skill.execute({ action: 'sa_kennwort_setzen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-1', login: 'sa' });
    expect([...w.tresor.keys()].sort()).toEqual(Object.keys(UM).sort());
    const w0 = welt({ 'sqllnx-sqllnx01-alfred-admin': 'Adm-1', 'sqllnx-sqllnx01-alfred-status': 'Sta-1' });
    expect((await w0.skill.execute({ action: 'sa_kennwort_setzen', zugang: 'sqllnx01' }, imChange)).error).toContain('sqllnx-sqllnx01-sa fehlt');
  });

  it('alfred_logins_entfernen: als sa, danach beide Tresor-Einträge entfernt; ohne entferne-Fähigkeit Abbruch vor dem Fernaufruf', async () => {
    const w = welt(UM, { zustand: 'geaendert' });
    const r = await w.skill.execute({ action: 'alfred_logins_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-1', login: 'sa' });
    expect(w.entfernt.sort()).toEqual(['sqllnx-sqllnx01-alfred-admin', 'sqllnx-sqllnx01-alfred-status']);
    const w2 = welt(UM, { zustand: 'geaendert' }, false);
    expect((await w2.skill.execute({ action: 'alfred_logins_entfernen', zugang: 'sqllnx01' }, imChange)).success).toBe(false);
    expect(w2.aufrufe).toEqual([]);
  });
});

describe.skipIf(!BASH || !PYTHON)('alfred_logins_entfernen ausgeführt', { timeout: 120_000 }, () => {
  it('nur als sa und nur ohne Host-Marke', () => {
    const r = lauf(alfredLoginsEntfernenSkript(), { sa: 'Sa-1', login: 'sa' }, { 'etc/sqllnx-sa-aus': 'x' });
    expect(r.rc).not.toBe(0);
    expect(r.sql).toBe('');
    const r2 = lauf(alfredLoginsEntfernenSkript(), { sa: 'Sa-1', login: 'sa' }, { sa_pruef: '1|0' });
    expect(r2.rc, r2.aus).toBe(0);
    expect(r2.sql).toContain('DROP LOGIN [alfred_admin]');
  });
});
