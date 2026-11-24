import { describe, it, expect } from 'vitest';
import { windowsSqlUeberwachung, windowsSqlJobBefunde } from './windows-sql-ueberwachung.js';
import type { SicherungsLage } from './sql-sicherung-lage.js';

const jobs = (diffStatus = 1, meldung = 'ok') => [
  { name: 'Alfred Sicherung diff', aktiv: 1, laeufe: [{ alterMin: 30, status: diffStatus, schritt: 1, meldung }] },
  { name: 'Alfred Sicherung log', aktiv: 1, laeufe: [{ alterMin: 5, status: 1, schritt: 1, meldung: 'ok' }] },
  { name: 'Alfred Sicherung voll', aktiv: 1, laeufe: [{ alterMin: 600, status: 1, schritt: 1, meldung: 'ok' }] },
];
const lage = (voll: number | null, log: number | null, j = jobs()): string => JSON.stringify({
  sicherungen: [...(voll === null ? [] : [{ db: 'i8d_ag01', typ: 'FULL' as const, alterMin: voll }]), ...(log === null ? [] : [{ db: 'i8d_ag01', typ: 'LOG' as const, alterMin: log }])],
  jobs: j, jobsLesbar: 1,
} satisfies SicherungsLage);
const ag = [{ name: 'i8d_ag01', replikat: 'SQL01', rolle: 'SECONDARY', modus: 'SYNCHRONOUS_COMMIT', failover: 'AUTOMATIC', gesundheit: 'HEALTHY', verbunden: 'CONNECTED' },
  { name: 'i8d_ag01', replikat: 'SQL02', rolle: 'PRIMARY', modus: 'SYNCHRONOUS_COMMIT', failover: 'AUTOMATIC', gesundheit: 'HEALTHY', verbunden: 'CONNECTED' }];
const st = (rechner: string, sicherungsLage: string) => ({
  success: true, data: { rechner, installiert: true, datenbanken: [{ name: 'i8d_ag01', zustand: 'ONLINE', modell: 'FULL', mb: 100 }], ags: ag,
    agDbs: [{ db: 'i8d_ag01', replikat: 'SQL01', zustand: 'SYNCHRONIZED' }, { db: 'i8d_ag01', replikat: 'SQL02', zustand: 'SYNCHRONIZED' }], sicherungsLage },
});
const lauf = (m: Record<string, unknown>) => windowsSqlUeberwachung(Object.keys(m), async z => m[z] as never);

describe('Windows-SQL-Überwachung (Realfall 24.11.: DIFF auf dem Primär gescheitert, FULL 4 Tage alt, kein Befund)', () => {
  it('Realfall: FULL 4 d alt und DIFF-Job fehlgeschlagen → zwei hohe Befunde, Ursache im Text', async () => {
    const r = await lauf({
      sql01: st('SQL01', lage(11 * 1440, 11 * 1440)),
      sql02: st('SQL02', lage(4 * 1440, 10, jobs(0, 'Executed as user: AD3033\\x. Cannot perform a differential backup for database "i8d_ag01" [SQLSTATE 42000] (Error 3035)'))),
    });
    expect(r.fehler).toEqual([]);
    expect([...r.erfasst].sort()).toEqual(['sql01', 'sql02']);
    expect(r.befunde.map(b => b.schluessel).sort()).toEqual(['ueberwachung:sql01:sicherung:i8d_ag01:voll', 'ueberwachung:sql02:job:Alfred Sicherung diff']);
    const job = r.befunde.find(b => b.schluessel?.includes(':job:'))!;
    expect(job).toMatchObject({ schwere: 'hoch', bereich: 'sql02', kategorie: 'ueberwachung' });
    expect(job.text).toContain('Cannot perform a differential backup');
    expect(job.text.startsWith('sql02')).toBe(false);
    expect(r.befunde.find(b => b.schluessel?.endsWith(':voll'))!.text).toBe('Datenbank i8d_ag01 (sql01, sql02): letzte FULL-Sicherung vor 4 d (Soll ≤ 26 h)');
  });
  it('alles frisch → kein Befund; jüngstes Replikat zählt', async () => {
    const r = await lauf({ sql01: st('SQL01', lage(11 * 1440, 11 * 1440)), sql02: st('SQL02', lage(600, 10)) });
    expect(r.befunde).toEqual([]);
  });
  it('LOG zu alt bzw. nie → hoch', async () => {
    const r = await lauf({ sql01: st('SQL01', lage(600, null)), sql02: st('SQL02', lage(600, 200)) });
    expect(r.befunde.map(b => b.text)).toEqual(['Datenbank i8d_ag01 (sql01, sql02): letzte LOG-Sicherung vor 3 h (Soll ≤ 2 h)']);
  });
  it('fail-closed: Replikat nicht lesbar → Alter nicht ausgewertet, gelesener Host nicht erfasst', async () => {
    const r = await lauf({ sql01: { success: false, error: 'WinRM aus' }, sql02: st('SQL02', lage(4 * 1440, 10)) });
    expect(r.befunde).toEqual([]);
    expect(r.erfasst.size).toBe(0);
    expect(r.fehler).toEqual(['sql01: WinRM aus', 'sql02: Sicherungsalter nicht ausgewertet — Datenbank i8d_ag01: Replikat sql01 nicht gelesen']);
  });
  it('unlesbare Lage oder Jobverlauf → Fehler, nicht erfasst; ohne SQL übersprungen; ohne Alfred-Jobs kein Altersbefund', async () => {
    const r = await lauf({
      dc01: { success: true, data: { rechner: 'DC01', installiert: false } },
      sql03: { success: true, data: { rechner: 'SQL03', installiert: true, sicherungsLageFehler: 'Zeitüberschreitung' } },
      sql04: { success: true, data: { rechner: 'SQL04', installiert: true, datenbanken: [{ name: 'x', zustand: 'ONLINE', modell: 'FULL', mb: 1 }], sicherungsLage: JSON.stringify({ sicherungen: [], jobs: [], jobsLesbar: 1 }) } },
      sql05: { success: true, data: { rechner: 'SQL05', installiert: true, sicherungsLage: JSON.stringify({ sicherungen: [], jobs: null, jobsLesbar: 0 }) } },
    });
    expect(r.uebersprungen).toEqual(['dc01']);
    expect(r.fehler).toEqual(['sql03: Sicherungslage nicht lesbar — Zeitüberschreitung', 'sql05: Jobverlauf nicht lesbar']);
    expect([...r.erfasst]).toEqual(['sql04']);
    expect(r.befunde).toEqual([]);
  });
  it('Jobbefund nur für aktive Alfred-Sicherungsjobs mit fehlgeschlagenem jüngstem Lauf', () => {
    const l: SicherungsLage = { jobsLesbar: 1, jobs: [
      { name: 'Fremder Job', aktiv: 1, laeufe: [{ status: 0, alterMin: 1, meldung: 'x' }] },
      { name: 'Alfred Sicherung voll', aktiv: 0, laeufe: [{ status: 0, alterMin: 1, meldung: 'x' }] },
      { name: 'Alfred Sicherung log', aktiv: 1, laeufe: [{ status: 1, alterMin: 1 }, { status: 0, alterMin: 20 }] },
    ] };
    expect(windowsSqlJobBefunde('sql02', l)).toEqual([]);
  });
});

describe('v1952 — Zuständigkeit der Schlüssel: Windows-Überwachung und SQL-Überwachung lösen nicht gegenseitig', () => {
  it('jeder Abgleich legt nur eigene Schlüssel an und löst nur eigene', async () => {
    const { befundeAlsProblems, istSqlUeberwachungsSchluessel } = await import('./befund-problems.js');
    const probleme: Array<{ id: string; title: string; status: string; detectionMethod?: string }> = [];
    const z = {
      liste: async () => probleme,
      anlegen: async (d: { title: string; detectionMethod?: string }) => { const id = `p${probleme.length + 1}`; probleme.push({ id, title: d.title, status: 'open', ...(d.detectionMethod ? { detectionMethod: d.detectionMethod } : {}) }); return id; },
      loese: async (id: string) => { probleme.find(p => p.id === id)!.status = 'resolved'; },
      assetFuer: async () => undefined,
    } as never;
    const sqlBefund = { schwere: 'hoch' as const, bereich: 'sql02', text: 'FULL alt', schluessel: 'ueberwachung:sql02:sicherung:i8d_ag01:voll', kategorie: 'ueberwachung' as const, zugang: 'sql02' };
    const dienst = { schwere: 'mittel' as const, bereich: 'sql02', text: 'Dienst x', schluessel: 'ueberwachung:sql02:dienst:x', kategorie: 'ueberwachung' as const, zugang: 'sql02' };
    const erf = { hosts: new Set(['sql02']), alle: false, kategorien: new Set(['ueberwachung']) };
    // SQL-Job: legt seinen Befund an; ein fremder Befund in seiner Liste wird ignoriert
    expect((await befundeAlsProblems([sqlBefund, dienst], z, { docId: 's', datum: 'd' }, { ...erf, schluessel: istSqlUeberwachungsSchluessel })).neu).toEqual(['p1']);
    // Windows-Überwachung: legt den Dienstbefund an und löst den SQL-Befund NICHT, obwohl er in ihrer Liste fehlt
    const w = await befundeAlsProblems([dienst], z, { docId: 'w', datum: 'd' }, erf);
    expect(w.neu).toEqual(['p2']); expect(w.geloest).toEqual([]);
    // SQL-Job ohne Befund: löst nur den eigenen, der Dienstbefund bleibt offen
    const s = await befundeAlsProblems([], z, { docId: 's', datum: 'd' }, { ...erf, schluessel: istSqlUeberwachungsSchluessel });
    expect(s.geloest).toEqual(['p1']);
    expect(probleme.map(p => p.status)).toEqual(['resolved', 'open']);
  });
});
