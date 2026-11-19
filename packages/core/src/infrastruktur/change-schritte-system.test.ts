import { describe, it, expect } from 'vitest';
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
