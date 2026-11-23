import { describe, it, expect } from 'vitest';
import { LINUX_SQL_BAUSTEINE, TLS_CRT, TLS_CRT_ALT } from './linux-sql.js';
import { tlsPfadUmstellenSkript } from './linux-sql-tls.js';
import { LinuxSqlSkill } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { pruefeChangePlan } from './change-schritte.js';

// Microsoft mssql-docker #979 — linux_sql tls_pfad_umstellen (Skill, Nachprüfung, Change-Regeln); Skriptverhalten in linux-sql-tls.test.ts

function skill(antwort: Record<string, unknown>) {
  const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
  const s = new LinuxSqlSkill({
    skript: async (_z, baustein, parameter, eingabe) => {
      aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) });
      return { code: 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' };
    },
    tresor: { namen: async () => new Set<string>(), lies: async () => '', setze: async () => undefined },
  });
  return { s, aufrufe };
}
const imChange = { ausChange: true } as never;

describe('linux_sql tls_pfad_umstellen (#979)', () => {
  it('Pfade: Zertifikat außerhalb von secrets, alter Pfad = secrets; Baustein registriert; an Pflicht', () => {
    expect(TLS_CRT).toBe('/var/opt/mssql/tls/tls.crt');
    expect(TLS_CRT_ALT).toBe('/var/opt/mssql/secrets/tls.crt');
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.tlsPfadUmstellen)).toBe(true);
    expect(tlsPfadUmstellenSkript({ an: true })).toContain(`CRT='${TLS_CRT}'`);
    expect(tlsPfadUmstellenSkript({ an: true })).not.toMatch(/systemctl (re)?start/);
    expect(() => tlsPfadUmstellenSkript({} as never)).toThrow('an: true oder false');
  });

  it('Skill: nur im Change, nur TLS-Hosts; Anzeige TLS_PFAD_NEU / TLS_PFAD_ALT; Nachprüfung gegen den Sollpfad', async () => {
    const a = skill({ zustand: 'geaendert', zertifikat: TLS_CRT, neustartNoetig: true, aenderungen: ['manifest', 'mssql-conf:tlscert'] });
    expect((await a.s.execute({ action: 'tls_pfad_umstellen', zugang: 'sqllnx01', an: true })).error).toContain('nur als Schritt eines freigegebenen Changes');
    const r = await a.s.execute({ action: 'tls_pfad_umstellen', zugang: 'sqllnx01', an: true }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toMatch(/^✅ TLS_PFAD_NEU sqllnx01: network\.tlscert = \/var\/opt\/mssql\/tls\/tls\.crt .*Neustart von SQL Server nötig/);
    expect(a.aufrufe[0]).toEqual({ baustein: LINUX_SQL_BAUSTEINE.tlsPfadUmstellen, parameter: { an: true } });
    const b = skill({ zustand: 'geaendert', zertifikat: TLS_CRT_ALT, neustartNoetig: true, aenderungen: [] });
    expect((await b.s.execute({ action: 'tls_pfad_umstellen', zugang: 'sqllnx01', an: false }, imChange)).display).toMatch(/^✅ TLS_PFAD_ALT sqllnx01: /);
    // falscher Pfad im Ergebnis → Nachprüfung scheitert
    const c = skill({ zustand: 'schon', zertifikat: TLS_CRT_ALT, neustartNoetig: false });
    expect((await c.s.execute({ action: 'tls_pfad_umstellen', zugang: 'sqllnx01', an: true }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    expect((await c.s.execute({ action: 'tls_pfad_umstellen', zugang: 'sql01', an: true }, imChange)).error).toContain('zugang: Zertifikatspfad nur auf');
  });

  it('Change: Rückweg Pflicht, genau tls_pfad_umstellen mit umgekehrtem an auf demselben Zugang', () => {
    const { s: sk } = skill({});
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'TLS-Pfad sqllnx01', begruendung: 'Microsoft #979', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'eigener Rückweg (an=false)', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (an: boolean, rueckweg?: unknown) => ({ titel: 'Pfad', art: 'aktion', skill: 'linux_sql', aktion: 'tls_pfad_umstellen', parameter: { zugang: 'sqllnx01', an }, zeitlimitS: 300, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pfad_umstellen', parameter: { zugang: 'sqllnx01', an: false } })])).toEqual([]);
    expect(f([schritt(true)]).some(x => x.includes('rueckweg fehlt'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pfad_umstellen', parameter: { zugang: 'sqllnx01', an: true } })]).some(x => x.includes('tls_pfad_umstellen: rueckweg an = false'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pfad_umstellen', parameter: { zugang: 'sqllnx02', an: false } })]).some(x => x.includes('muss auf demselben Zugang laufen'))).toBe(true);
    expect(f([{ ...schritt(true, { skill: 'linux_sql', aktion: 'tls_pfad_umstellen', parameter: { zugang: 'sqllnx01', an: false } }), parameter: { zugang: 'sql01', an: true } }]).some(x => x.includes('Zertifikatspfad nur auf'))).toBe(true);
  });
});
