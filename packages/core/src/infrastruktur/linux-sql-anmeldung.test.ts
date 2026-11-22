import { describe, it, expect } from 'vitest';
import { waehleAnmeldung, sqlAnmeldung, alfredLoginTresor, ADMIN_LOGIN, STATUS_LOGIN } from './linux-sql-anmeldung.js';

/** I8e Folge-Etappe (Spec 2026-11-22 §7.2) — Login-Wahl fest nach aktionsArt, kein Rückfall auf sa nach der Umstellung */
const SA = 'sqllnx-sqllnx01-sa';
const ADM = 'sqllnx-sqllnx01-alfred-admin';
const STA = 'sqllnx-sqllnx01-alfred-status';

describe('waehleAnmeldung', () => {
  it('Tresor-Namen der Alfred-Logins', () => {
    expect(alfredLoginTresor('SQLLNX01', ADMIN_LOGIN)).toBe(ADM);
    expect(alfredLoginTresor('sqllnx01', STATUS_LOGIN)).toBe(STA);
  });

  it('beide Alfred-Einträge fehlen → sa (Übergang)', () => {
    expect(waehleAnmeldung(new Set([SA]), 'sqllnx01', 'aendern')).toEqual({ login: 'sa', tresor: SA });
    expect(waehleAnmeldung(new Set([SA]), 'sqllnx01', 'lesen')).toEqual({ login: 'sa', tresor: SA });
  });

  it('umgestellt: aendern → alfred_admin, lesen → alfred_status', () => {
    const n = new Set([SA, ADM, STA]);
    expect(waehleAnmeldung(n, 'sqllnx01', 'aendern')).toEqual({ login: 'alfred_admin', tresor: ADM });
    expect(waehleAnmeldung(n, 'sqllnx01', 'lesen')).toEqual({ login: 'alfred_status', tresor: STA });
  });

  it('nur alfred-admin vorhanden → Abbruch für lesen UND aendern, kein Rückfall auf sa', () => {
    const n = new Set([SA, ADM]);
    for (const art of ['lesen', 'aendern'] as const) {
      expect(() => waehleAnmeldung(n, 'sqllnx01', art)).toThrow(/Tresor-Eintrag sqllnx-sqllnx01-alfred-status fehlt.*kein Rückfall auf sa/);
    }
  });

  it('nur alfred-status vorhanden → Abbruch mit alfred-admin', () => {
    expect(() => waehleAnmeldung(new Set([STA]), 'sqllnx01', 'lesen')).toThrow(/sqllnx-sqllnx01-alfred-admin fehlt/);
  });

  it('weder sa noch Alfred-Einträge → Abbruch', () => {
    expect(() => waehleAnmeldung(new Set(), 'sqllnx01', 'aendern')).toThrow(/sqllnx-sqllnx01-sa fehlt/);
  });
});

describe('sqlAnmeldung', () => {
  it('liest das Kennwort des gewählten Logins, legt es in geheim ab und liefert die Eingabe {sa, login}', async () => {
    const gelesen: string[] = [];
    const t = { namen: async () => new Set([SA, ADM, STA]), lies: async (n: string) => { gelesen.push(n); return `kw-${n}`; } };
    const geheim: string[] = [];
    const a = await sqlAnmeldung(t, 'sqllnx01', 'lesen', 'Status', geheim);
    expect(a.login).toBe('alfred_status');
    expect(gelesen).toEqual([STA]);
    expect(geheim).toEqual([`kw-${STA}`]);
    expect(a.eingabe).toEqual({ sa: `kw-${STA}`, login: 'alfred_status' });
  });
});
