import { describe, it, expect } from 'vitest';
import { erneuereDienstTokens, tokenAusEnv } from './auth-dienste.js';

describe('v1315 erneuereDienstTokens — DB-Dienste derselben Client-ID bekommen den neuen Token', () => {
  const zeilen = [
    { id: '1', serviceType: 'calendar', serviceName: 'fam@dohnal.co', config: JSON.stringify({ provider: 'microsoft', microsoft: { clientId: 'c1', tenantId: 't', refreshToken: 'alt', sharedCalendar: 'fam@dohnal.co' } }) },
    { id: '2', serviceType: 'calendar', serviceName: 'microsoft', config: JSON.stringify({ provider: 'microsoft', microsoft: { clientId: 'c1', refreshToken: 'neu' } }) },
    { id: '3', serviceType: 'email', serviceName: 'gmail', config: JSON.stringify({ provider: 'gmail', imap: {} }) },
    { id: '4', serviceType: 'calendar', serviceName: 'fremd', config: JSON.stringify({ provider: 'microsoft', microsoft: { clientId: 'c2', refreshToken: 'alt' } }) },
    { id: '5', serviceType: 'todo', serviceName: 'kaputt', config: '{nicht json' },
  ];

  it('ersetzt nur bei gleicher Client-ID und abweichendem Token; sharedCalendar bleibt', () => {
    const u = erneuereDienstTokens(zeilen, 'c1', 'neu');
    expect(u.map(x => x.serviceName)).toEqual(['fam@dohnal.co']);
    const cfg = JSON.parse(u[0]!.config) as { microsoft: Record<string, string> };
    expect(cfg.microsoft.refreshToken).toBe('neu');
    expect(cfg.microsoft.sharedCalendar).toBe('fam@dohnal.co');
    expect(cfg.microsoft.tenantId).toBe('t');
  });

  it('nimmt auch schon geparste Konfigurationen an', () => {
    const u = erneuereDienstTokens([{ id: '9', serviceType: 'contacts', serviceName: 'microsoft', config: { microsoft: { clientId: 'c1', refreshToken: 'x' } } }], 'c1', 'y');
    expect(u).toHaveLength(1);
  });
});

describe('v1315 tokenAusEnv', () => {
  it('liest den Kalender-Token vor dem E-Mail-Token, ohne Anführungszeichen und CR', () => {
    const env = 'A=1\nALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN="mail"\r\nALFRED_MICROSOFT_CALENDAR_REFRESH_TOKEN=\'kal\'\r\n';
    expect(tokenAusEnv(env)).toEqual({ schluessel: 'ALFRED_MICROSOFT_CALENDAR_REFRESH_TOKEN', token: 'kal' });
    expect(tokenAusEnv('X=1\n')).toBeUndefined();
  });
});
