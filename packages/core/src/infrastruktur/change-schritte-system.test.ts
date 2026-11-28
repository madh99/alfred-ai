import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruefeChangePlan, ZIELSYSTEM, type PruefKontext } from './change-schritte.js';

// I8e Task 1 — feste Systemprüfung: Windows-Skills nur auf Windows-Zugängen, Linux-Skills nur auf Linux-Zugängen
const skill = (name: string, aktionen: string[]) =>
  ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, zugang: { type: 'string' } }, required: ['action'] } } });
const SKILLS: Record<string, ReturnType<typeof skill>> = {
  windows_pki: skill('windows_pki', ['sql_tls_anfordern', 'status']),
  windows_ad: skill('windows_ad', ['status', 'rolle_installieren']),
  linux_sql: skill('linux_sql', ['status']),
  linux_ha: skill('linux_ha', ['status']),
  fernzugriff: skill('fernzugriff', ['ausfuehren', 'lesen']),
};
const ctx = (mitSystem = true): PruefKontext => ({
  skill: n => SKILLS[n] as never,
  asset: () => undefined,
  changes: [],
  jetzt: new Date('2026-11-19T10:00:00Z'),
  zugaenge: new Set(['sqllnx01', 'sqllnx02', 'sql01', 'sql02']),
  ...(mitSystem ? { zugangSystem: new Map<string, 'linux' | 'windows'>([['sqllnx01', 'linux'], ['sqllnx02', 'linux'], ['sql01', 'windows'], ['sql02', 'windows']]) } : {}),
});
const plan = (schritte: unknown[]) => ({ titel: 'Systemprüfung', begruendung: 'Test der festen Systemprüfung', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: [], schritte });
const aktion = (skillName: string, aktionName: string, parameter: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ titel: 'Schritt', art: 'aktion', skill: skillName, aktion: aktionName, parameter, ...extra });

describe('I8e Systemprüfung Windows/Linux', () => {
  it('Tabelle: linux_sql/linux_ha → linux, windows_* → windows', () => {
    expect(ZIELSYSTEM.linux_sql).toBe('linux');
    expect(ZIELSYSTEM.linux_ha).toBe('linux');
    expect(ZIELSYSTEM.windows_ad).toBe('windows');
    expect(ZIELSYSTEM.windows_pki).toBe('windows');
    expect(ZIELSYSTEM.windows_cluster).toBe('windows');
  });

  it('Windows-Skill auf Linux-Zugang → Fehler', () => {
    const r = pruefeChangePlan(plan([aktion('windows_pki', 'sql_tls_anfordern', { zugang: 'sqllnx01' })]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 1: sqllnx01 ist Linux — windows_pki gehört auf einen Windows-Zugang');
  });

  it('Linux-Skill auf Windows-Zugang → Fehler', () => {
    const r = pruefeChangePlan(plan([aktion('linux_sql', 'status', { zugang: 'sql01' })]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 1: sql01 ist Windows — linux_sql gehört auf einen Linux-Zugang');
  });

  it('richtiges System → kein Systemfehler', () => {
    const r = pruefeChangePlan(plan([aktion('linux_sql', 'status', { zugang: 'SQLLNX01' }), aktion('windows_ad', 'status', { zugang: 'sql01' })]), ctx());
    expect(r.fehler.filter(x => /ist (Linux|Windows) —/.test(x))).toEqual([]);
  });

  it('Rückweg auf falschem System → Fehler', () => {
    const r = pruefeChangePlan(plan([aktion('windows_ad', 'rolle_installieren', { zugang: 'sql01' }, { rueckweg: { skill: 'windows_ad', aktion: 'status', parameter: { zugang: 'sqllnx02' } } })]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 1 (Rückweg): sqllnx02 ist Linux — windows_ad gehört auf einen Windows-Zugang');
  });

  it('Prüfung typ skill auf falschem System → Fehler', () => {
    const r = pruefeChangePlan(plan([{ titel: 'Prüfen', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_ha', aktion: 'status', parameter: { zugang: 'sql02' } } }]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 1: sql02 ist Windows — linux_ha gehört auf einen Linux-Zugang');
  });

  it('Verweis {{…}} als Zugang → kein Systemfehler', () => {
    const r = pruefeChangePlan(plan([aktion('windows_pki', 'status', { zugang: '{{schritt1.zugang}}' })]), ctx());
    expect(r.fehler.filter(x => /ist (Linux|Windows) —/.test(x))).toEqual([]);
  });

  it('fernzugriff auf beliebigem System → kein Systemfehler', () => {
    const r = pruefeChangePlan(plan([aktion('fernzugriff', 'lesen', { name: 'sql01' }), aktion('fernzugriff', 'lesen', { name: 'sqllnx01' })]), ctx());
    expect(r.fehler.filter(x => /ist (Linux|Windows) —/.test(x))).toEqual([]);
  });

  it('ohne zugangSystem im Kontext → kein Systemfehler (abwärtskompatibel)', () => {
    const r = pruefeChangePlan(plan([aktion('windows_pki', 'status', { zugang: 'sqllnx01' })]), ctx(false));
    expect(r.fehler.filter(x => /ist (Linux|Windows) —/.test(x))).toEqual([]);
  });
});

// Fix-Runde 1 — Vollständigkeit der Tabelle und vom Plan angelegte Zugänge
describe('I8e Systemprüfung: Vollständigkeit und Plan-Zugänge', () => {
  it('jeder *-skill.ts mit zugang-Eingabe steht in ZIELSYSTEM oder der OS-neutralen Liste', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const neutral = ['infrastruktur'];
    const gefunden: string[] = [];
    for (const datei of readdirSync(dir).filter(d => d.endsWith('-skill.ts'))) {
      const q = readFileSync(join(dir, datei), 'utf8');
      const name = /^\s*name: '([a-z_]+)'/m.exec(q)?.[1];
      if (!name) continue;
      if (/^(windows_|linux_)/.test(name) || /zugang: \{ type: 'string'/.test(q)) gefunden.push(name);
    }
    expect(gefunden).toEqual(expect.arrayContaining(['linux_sql', 'linux_ha', 'windows_ad', 'windows_pki', 'windows_cluster', 'sql_server', 'pki_lab']));
    for (const n of gefunden) expect(n in ZIELSYSTEM || neutral.includes(n), `${n} fehlt in ZIELSYSTEM`).toBe(true);
    expect(ZIELSYSTEM.sql_server).toBe('windows');
    expect(ZIELSYSTEM.pki_lab).toBe('windows');
  });

  const fehlerSystem = (r: { fehler: string[] }) => r.fehler.filter(x => /ist (Linux|Windows) —|Betriebssystem von/.test(x));

  it('vom Plan angelegter Windows-Zugang (provision_windows_vm) + linux_sql → Fehler', () => {
    const r = pruefeChangePlan(plan([aktion('proxmox', 'provision_windows_vm', { hostname: 'neuwin01' }), aktion('linux_sql', 'status', { zugang: 'neuwin01' })]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 2: neuwin01 ist Windows — linux_sql gehört auf einen Linux-Zugang');
  });

  it('vom Plan angelegter Linux-Zugang (fernzugriff anlegen ohne system) + windows_ad → Fehler', () => {
    const r = pruefeChangePlan(plan([aktion('fernzugriff', 'anlegen', { name: 'neulnx01' }), aktion('windows_ad', 'status', { zugang: 'neulnx01' })]), ctx());
    expect(r.fehler.join('\n')).toContain('Schritt 2: neulnx01 ist Linux — windows_ad gehört auf einen Windows-Zugang');
  });

  it('provision_vm → Linux; richtige Kombinationen bestehen', () => {
    const r = pruefeChangePlan(plan([aktion('proxmox', 'provision_vm', { hostname: 'neulnx02' }), aktion('proxmox', 'provision_windows_vm', { hostname: 'neuwin02' }), aktion('linux_sql', 'status', { zugang: 'neulnx02' }), aktion('windows_ad', 'status', { zugang: 'neuwin02' }), aktion('fernzugriff', 'anlegen', { name: 'neuwin03', system: 'windows' }), aktion('windows_pki', 'status', { zugang: 'neuwin03' })]), ctx());
    expect(fehlerSystem(r)).toEqual([]);
  });

  it('Plan-Zugang mit nicht ermittelbarem System + OS-Skill → Fehler mit Bitte um Systemangabe', () => {
    const r = pruefeChangePlan(plan([aktion('fernzugriff', 'ausfuehren', { name: 'sql01', befehl: 'uptime' }, {}), aktion('linux_ha', 'status', { zugang: 'rätsel01' }), aktion('proxmox', 'status', { name: 'rätsel01' })]), ctx());
    expect(fehlerSystem(r).join('\n')).toContain('Betriebssystem von rätsel01 ist nicht bekannt');
  });
});

// Realfall 28.11. (811c766d): fernzugriff.ausfuehren als root läuft in sh (dash) — bash-Syntax schon beim Planen melden
describe('sh-Prüfung für fernzugriff.ausfuehren', () => {
  const bash = 'set -euo pipefail\necho ok';
  it('Linux-Zugang: Schritt und Rückweg werden gemeldet', () => {
    const r = pruefeChangePlan(plan([aktion('fernzugriff', 'ausfuehren', { name: 'sqllnx01', befehl: bash }, { rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'sqllnx01', befehl: bash } } })]), ctx());
    const sh = r.fehler.filter(x => x.includes('bash-Syntax'));
    expect(sh).toHaveLength(2);
    expect(sh.some(x => x.includes('(Rückweg)'))).toBe(true);
  });
  it('Windows-Zugang, als_root:false und POSIX bleiben frei', () => {
    const r1 = pruefeChangePlan(plan([aktion('fernzugriff', 'ausfuehren', { name: 'sql01', befehl: bash })]), ctx());
    const r2 = pruefeChangePlan(plan([aktion('fernzugriff', 'ausfuehren', { name: 'sqllnx01', befehl: bash, als_root: false })]), ctx());
    const r3 = pruefeChangePlan(plan([aktion('fernzugriff', 'ausfuehren', { name: 'sqllnx01', befehl: 'set -eu\necho ok' })]), ctx());
    for (const r of [r1, r2, r3]) expect(r.fehler.filter(x => x.includes('bash-Syntax'))).toEqual([]);
  });
});
