import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LINUX_HA_BAUSTEINE, haErgebnis } from './linux-ha.js';
import { knotenStandbySkript, pruefeKnotenStandby } from './linux-ha-standby.js';
import { LinuxHaSkill, LINUX_HA_MIN_ZEITLIMIT_S } from './linux-ha-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8e Folge-Etappe (Spec 2026-11-22 §7.3, Plan Task 5): linux_ha knoten_standby — Knoten des Zugangs in Pacemaker-Standby und zurück
afterEach(() => new Promise<void>(r => setImmediate(r)));
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const imChange = { ausChange: true } as never;

/** crm_mon-XML: Knoten (Name → standby), Promoted-Knoten von ag_cluster, Quorum */
function crm(standby: Record<string, boolean>, promoted: string, quorum = true, online = true, rolle = 'Promoted', ohnePromoted = false): string {
  const knoten = Object.entries(standby).map(([n, s]) => `<node name="${n}" id="${n}" online="${online}" standby="${s}"/>`).join('');
  // Unpromoted-Instanzen auf allen Knoten außer dem Primär und außer Knoten im Standby (dort gestoppt, ohne node-Kind)
  const unprom = Object.entries(standby).filter(([n, s]) => n !== promoted && !s).map(([n]) => `<resource id="ag_cluster" role="Unpromoted" active="true"><node name="${n}" id="${n}"/></resource>`).join('');
  const gestoppt = Object.entries(standby).filter(([, s]) => s).map(() => '<resource id="ag_cluster" role="Stopped" active="false"/>').join('');
  return `<pacemaker-result><summary><current_dc present="true" with_quorum="${quorum}"/><nodes_configured number="3"/></summary><nodes>${knoten}</nodes>`
    + `<resources><clone id="ag_cluster-clone">${ohnePromoted ? '' : `<resource id="ag_cluster" role="${rolle}" active="true"><node name="${promoted}" id="${promoted}"/></resource>`}`
    + `${unprom}${gestoppt}</clone></resources></pacemaker-result>`;
}

/** führt das Skript auf „ich“ aus; pcs node standby/unstandby schaltet die XML-Datei um (wie Pacemaker), protokolliert nach $T/log */
/** pcs-Stub: „voll“ = Attribut + Instanz gestoppt (wie Pacemaker), „attribut“ = nur das Attribut (Instanz läuft weiter), „nichts“ */
function lauf(an: boolean, ich: string, xml: string, pcs: 'voll' | 'attribut' | 'nichts' = 'voll', warteAg = false) {
  const attribut = 'case "$2" in standby) sed -i "s/name=\\"$3\\" id=\\"$3\\" online=\\"true\\" standby=\\"false\\"/name=\\"$3\\" id=\\"$3\\" online=\\"true\\" standby=\\"true\\"/" "$T/crm.xml" ;; unstandby) sed -i "s/name=\\"$3\\" id=\\"$3\\" online=\\"true\\" standby=\\"true\\"/name=\\"$3\\" id=\\"$3\\" online=\\"true\\" standby=\\"false\\"/" "$T/crm.xml" ;; esac';
  const instanz = '[ "$2" != standby ] || sed -i "s#<resource id=\\"ag_cluster\\" role=\\"Unpromoted\\" active=\\"true\\"><node name=\\"$3\\" id=\\"$3\\"/></resource>#<resource id=\\"ag_cluster\\" role=\\"Stopped\\" active=\\"false\\"/>#" "$T/crm.xml"; [ "$2" != unstandby ] || sed -i "0,/<resource id=\\"ag_cluster\\" role=\\"Stopped\\" active=\\"false\\"\\/>/s##<resource id=\\"ag_cluster\\" role=\\"Unpromoted\\" active=\\"true\\"><node name=\\"$3\\" id=\\"$3\\"/></resource>#" "$T/crm.xml"';
  const stubs = [
    `python3() { PYTHONIOENCODING=utf-8 '${PYTHON_PFAD}' "$@" | tr -d '\\r'; }`,
    `hostname() { echo ${ich}; }`, 'sleep() { :; }',
    'crm_mon() { cat "$T/crm.xml"; }',
    `pcs() { echo "pcs $*" >>"$T/log"; ${pcs === 'nichts' ? ':' : pcs === 'attribut' ? attribut : `${attribut}; ${instanz}`}; }`,
  ].join('\n');
  const text = knotenStandbySkript({ an, ...(warteAg ? { warteAg } : {}) }).replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const huelle = ['T=$(mktemp -d)', `printf '%s' '${xml}' >"$T/crm.xml"`, "ALFRED_EINGABE=''", `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`, 'echo "---AUS"; cat "$T/aus"; echo "---LOG"; cat "$T/log" 2>/dev/null; rm -rf "$T"'].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout.replace(/\r/g, '');
  const aus = o.split('---AUS\n')[1]?.split('---LOG\n')[0] ?? '';
  return { rc: Number(/RC=(\d+)/.exec(o)?.[1] ?? -1), aus, e: haErgebnis<Record<string, unknown>>(aus), log: o.split('---LOG\n')[1] ?? '' };
}
const ALLE = (s: Partial<Record<string, boolean>> = {}) => ({ sqllnx01: false, sqllnx02: false, sqllnxcfg: false, ...s }) as Record<string, boolean>;

describe('knoten_standby — Register, Planung', () => {
  it('registriert, ändernd, nur im Change, Rückweg an umgekehrt', () => {
    expect(linuxBausteinBekannt(LINUX_HA_BAUSTEINE.knotenStandby)).toBe(true);
    expect(aktionsArt('linux_ha', 'knoten_standby')).toBe('aendern');
    expect(LINUX_HA_MIN_ZEITLIMIT_S.knoten_standby).toBeGreaterThan(0);
    expect(pruefeKnotenStandby({ an: 'ja' })).toContain('an:');
    const sk = new LinuxHaSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_ha' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'Standby', begruendung: 'I8e Folge-Etappe N2: Notfallweg-Beweis auf sqllnxcfg', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnxcfg'], ohneSicherungGrund: 'eigener Rückweg', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (an: boolean, rueckweg?: unknown) => ({ titel: 's', art: 'aktion', skill: 'linux_ha', aktion: 'knoten_standby', parameter: { zugang: 'sqllnxcfg', an }, zeitlimitS: 600, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt(true, { skill: 'linux_ha', aktion: 'knoten_standby', parameter: { zugang: 'sqllnxcfg', an: false } })])).toEqual([]);
    expect(f([schritt(true, { skill: 'linux_ha', aktion: 'knoten_standby', parameter: { zugang: 'sqllnxcfg', an: true } })]).some(x => x.includes('knoten_standby: rueckweg an = false'))).toBe(true);
  });
});

describe.skipIf(!BASH || !PYTHON)('knoten_standby ausgeführt', { timeout: 120_000 }, () => {
  it('Konfig-Knoten in Standby: pcs node standby, Selbstprüfung standby=true', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE(), 'sqllnx01'));
    expect(r.rc, r.aus).toBe(0);
    expect(r.log.trim()).toBe('pcs node standby sqllnxcfg');
    expect(r.e).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnxcfg', standby: true });
  });

  it('Primär (Promoted) → Abbruch ohne Änderung', () => {
    const r = lauf(true, 'sqllnx01', crm(ALLE(), 'sqllnx01'));
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/sqllnx01 ist Primär/);
    expect(r.log).toBe('');
  });

  it('ohne Quorum → Abbruch ohne Änderung', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE(), 'sqllnx01', false));
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/Quorum/);
    expect(r.log).toBe('');
  });

  it('schon im Standby → nichts zu tun', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE({ sqllnxcfg: true }), 'sqllnx01'));
    expect(r.rc, r.aus).toBe(0);
    expect(r.log).toBe('');
    expect(r.e).toMatchObject({ zustand: 'schon', standby: true });
  });

  it('zurück: pcs node unstandby, Selbstprüfung standby=false', () => {
    const r = lauf(false, 'sqllnxcfg', crm(ALLE({ sqllnxcfg: true }), 'sqllnx01'));
    expect(r.rc, r.aus).toBe(0);
    expect(r.log.trim()).toBe('pcs node unstandby sqllnxcfg');
    expect(r.e).toMatchObject({ zustand: 'geaendert', standby: false });
  });

  it('pcs wirkt nicht → Abbruch nach der Wartezeit', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE(), 'sqllnx01'), 'nichts');
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/Standby von sqllnxcfg nicht bestätigt/);
  });

  it('Review I1: Primär mit Rollenname „Master“ → Abbruch ohne Änderung', () => {
    const r = lauf(true, 'sqllnx01', crm(ALLE(), 'sqllnx01', true, true, 'Master'));
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/sqllnx01 ist Primär/);
    expect(r.log).toBe('');
  });

  it('Review I1: kein Primär erkennbar → Abbruch ohne Änderung (fail-closed)', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE(), 'sqllnx01', true, true, 'Promoted', true));
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/kein Primär/);
    expect(r.log).toBe('');
  });

  it('Review I2: Attribut gesetzt, Instanz läuft noch → Abbruch nach der Wartezeit (nicht als Erfolg)', () => {
    const r = lauf(true, 'sqllnxcfg', crm(ALLE(), 'sqllnx01'), 'attribut');
    expect(r.rc).not.toBe(0);
    expect(r.e?.fehler).toMatch(/ag_cluster auf sqllnxcfg noch aktiv/);
  });
});

describe('Skill', () => {
  it('nur im Change; schickt an, keine Geheimnisse', async () => {
    const aufrufe: Array<{ baustein: string; p: unknown; eingabe?: string }> = [];
    const sk = new LinuxHaSkill({ skript: async (_z, baustein, p, eingabe) => { aufrufe.push({ baustein, p, eingabe }); return { code: 0, stdout: `ALFRED-HA ${JSON.stringify({ zustand: 'geaendert', knoten: 'sqllnxcfg', standby: true })}\n`, stderr: '' }; } });
    expect((await sk.execute({ action: 'knoten_standby', zugang: 'sqllnxcfg', an: true }, {} as never)).success).toBe(false);
    const r = await sk.execute({ action: 'knoten_standby', zugang: 'sqllnxcfg', an: true }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(aufrufe[0]).toEqual({ baustein: LINUX_HA_BAUSTEINE.knotenStandby, p: { an: true }, eingabe: undefined });
    expect(r.display).toContain('Knoten sqllnxcfg: Standby an');
  });
});

/**
 * Realfall 23.11. (Entwurf 2f31b31d): die Planprüfung verlangte nach dem Rückweg einen Nachweis, dass der Knoten wieder mitarbeitet,
 * und vor dem Neustart einen eigenen Standby-Nachweis. warte_ag (nur an=false): nach unstandby warten, bis die ag_cluster-Instanz auf
 * dem Knoten wieder aktiv ist (bis 300 s), sonst Abbruch. Für Replikat-Knoten; ohne warte_ag wie bisher.
 */
describe('knoten_standby — warte_ag', () => {
  it.skipIf(!BASH || !PYTHON)('zurück mit warte_ag: Instanz kommt wieder → Erfolg, agAktiv true', () => {
    const r = lauf(false, 'sqllnx02', crm(ALLE({ sqllnx02: true }), 'sqllnx01'), 'voll', true);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', standby: false, agAktiv: true });
  });
  it.skipIf(!BASH || !PYTHON)('zurück mit warte_ag: Instanz bleibt gestoppt → Abbruch', () => {
    const r = lauf(false, 'sqllnx02', crm(ALLE({ sqllnx02: true }), 'sqllnx01'), 'attribut', true);
    expect(r.rc).not.toBe(0);
    expect(r.aus).toContain('ag_cluster auf sqllnx02 nicht wieder aktiv');
  }, 90_000);
  it.skipIf(!BASH || !PYTHON)('schon zurück, Instanz aktiv, warte_ag → nichts zu tun mit agAktiv true', () => {
    const r = lauf(false, 'sqllnx02', crm(ALLE(), 'sqllnx01'), 'voll', true);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', standby: false, agAktiv: true });
  });
  it('Parameter: warte_ag nur Wahrheitswert; Skill reicht ihn durch; Rückweg mit warte_ag ist zulässig', async () => {
    expect(pruefeKnotenStandby({ an: false, warte_ag: 'ja' })).toContain('warte_ag');
    expect(pruefeKnotenStandby({ an: false, warte_ag: true })).toBeUndefined();
    const aufrufe: unknown[] = [];
    const sk = new LinuxHaSkill({ skript: async (_z, _b, p) => { aufrufe.push(p); return { code: 0, stdout: `ALFRED-HA ${JSON.stringify({ zustand: 'geaendert', knoten: 'sqllnx02', standby: false, agAktiv: true })}\n`, stderr: '' }; } });
    const r = await sk.execute({ action: 'knoten_standby', zugang: 'sqllnx02', an: false, warte_ag: true }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(aufrufe[0]).toEqual({ an: false, warteAg: true });
    expect(r.display).toContain('Knoten sqllnx02: Standby aus, AG-Instanz aktiv');
  });
});
