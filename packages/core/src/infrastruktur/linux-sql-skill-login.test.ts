import { describe, it, expect } from 'vitest';
import { LinuxSqlSkill } from './linux-sql-skill.js';
import { LinuxHaSkill } from './linux-ha-skill.js';
import { LINUX_HA_BAUSTEINE } from './linux-ha.js';
import { LINUX_SQL_BAUSTEINE } from './linux-sql.js';

// I8e Folge-Etappe (Spec 2026-11-22 §7.2, Plan Task 3): Bausteine melden sich nach der Umstellung als alfred_admin bzw. alfred_status an

interface Aufruf { zugang: string; baustein: string; eingabe?: string }
const imChange = { ausChange: true } as never;
const SA = { 'sqllnx-sqllnx01-sa': 'Sa-Eins-1111' };
const UM = { ...SA, 'sqllnx-sqllnx01-alfred-admin': 'Adm-Eins-1111', 'sqllnx-sqllnx01-alfred-status': 'Sta-Eins-1111' };
const HALB = { ...SA, 'sqllnx-sqllnx01-alfred-admin': 'Adm-Eins-1111' };

function deps(antwort: (baustein: string) => Record<string, unknown>, tresorDa: Record<string, string>) {
  const aufrufe: Aufruf[] = [];
  const tresor = new Map(Object.entries(tresorDa));
  const gesetzt: string[] = [];
  return {
    aufrufe, gesetzt,
    d: {
      skript: async (zugang: string, baustein: string, _p: unknown, eingabe?: string) => {
        aufrufe.push({ zugang, baustein, ...(eingabe !== undefined ? { eingabe } : {}) });
        const a = antwort(baustein);
        const praefix = baustein.startsWith('ha.') ? 'ALFRED-HA' : 'ALFRED-SQL';
        return { code: a.zustand === 'fehler' ? 1 : 0, stdout: `${praefix} ${JSON.stringify(a)}\n`, stderr: '' };
      },
      tresor: {
        namen: async () => new Set(tresor.keys()),
        lies: async (n: string) => { const w = tresor.get(n); if (w === undefined) throw new Error(`fehlt ${n}`); return w; },
        setze: async (n: string, w: string) => { gesetzt.push(n); tresor.set(n, w); },
      },
    },
  };
}
const eingabe = (a: Aufruf | undefined) => JSON.parse(a?.eingabe ?? '{}') as Record<string, unknown>;

describe('linux_sql nach der Umstellung', () => {
  it('ändernder Baustein (reste_entfernen) schickt alfred_admin mit dessen Kennwort; Anzeige nennt das Login', async () => {
    const w = deps(() => ({ zustand: 'nichts', entfernt: [], inGebrauch: [] }), UM);
    const r = await new LinuxSqlSkill(w.d as never).execute({ action: 'reste_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(eingabe(w.aufrufe[0])).toEqual({ sa: 'Adm-Eins-1111', login: 'alfred_admin' });
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('(angemeldet als alfred_admin)');
    expect((r.data as Record<string, unknown>).login).toBe('alfred_admin');
  });

  it('status schickt alfred_status', async () => {
    const w = deps(() => ({ zustand: 'gelesen', installiert: true, dienst: 'active' }), UM);
    const r = await new LinuxSqlSkill(w.d as never).execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    expect(eingabe(w.aufrufe[0])).toEqual({ sa: 'Sta-Eins-1111', login: 'alfred_status' });
    expect(r.display).toContain('(angemeldet als alfred_status)');
  });

  it('vor der Umstellung: status und Bausteine wie bisher als sa, Anzeige ohne Zusatz', async () => {
    const w = deps(() => ({ zustand: 'gelesen', installiert: true, dienst: 'active' }), SA);
    const r = await new LinuxSqlSkill(w.d as never).execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    expect(eingabe(w.aufrufe[0])).toEqual({ sa: 'Sa-Eins-1111', login: 'sa' });
    expect(r.display).not.toContain('angemeldet als');
  });

  it('ohne jeden Tresor-Eintrag: status nur Betriebssystem-Sicht (ohne Eingabe), wie bisher', async () => {
    const w = deps(() => ({ zustand: 'gelesen', installiert: false }), {});
    await new LinuxSqlSkill(w.d as never).execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
  });

  it('halb umgestellt: status und ändernde Bausteine brechen vor jedem Fernaufruf ab, kein Rückfall auf sa', async () => {
    const w = deps(() => ({ zustand: 'gelesen' }), HALB);
    const s = new LinuxSqlSkill(w.d as never);
    const r1 = await s.execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    const r2 = await s.execute({ action: 'reste_entfernen', zugang: 'sqllnx01' }, imChange);
    for (const r of [r1, r2]) { expect(r.success).toBe(false); expect(r.error).toMatch(/alfred-status fehlt.*kein Rückfall auf sa/); }
    expect(w.aufrufe).toEqual([]);
  });

  it('installieren auf umgestellter Instanz: Selbstprüfung als alfred_admin, kein neues sa-Kennwort, kein Tresor-Eintrag', async () => {
    const w = deps(() => ({ zustand: 'schon', version: '17.0.4006.2', edition: 'Enterprise Developer' }), UM);
    const r = await new LinuxSqlSkill(w.d as never).execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(eingabe(w.aufrufe[0])).toEqual({ sa: 'Adm-Eins-1111', login: 'alfred_admin' });
    expect(w.gesetzt).toEqual([]);
    expect(r.display).toContain('nichts zu tun');
  });
});

describe('linux_ha nach der Umstellung', () => {
  it('ag_failover: Ziel halb umgestellt → Abbruch vor jedem Fernaufruf', async () => {
    const w = deps(() => ({ zustand: 'gelesen' }), { 'sqllnx-sqllnx02-sa': 'x', 'sqllnx-sqllnx02-alfred-admin': 'y' });
    const r = await new LinuxHaSkill(w.d as never).execute({ action: 'ag_failover', zugang: 'sqllnx01', ziel: 'sqllnx02' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/sqllnx-sqllnx02-alfred-status fehlt/);
    expect(w.aufrufe.filter(a => a.baustein === LINUX_HA_BAUSTEINE.agFailover)).toEqual([]);
  });
});

it('Bausteinnamen vorhanden', () => { expect(LINUX_SQL_BAUSTEINE.resteEntfernen).toBeTruthy(); });
