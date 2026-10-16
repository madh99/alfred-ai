import { describe, it, expect } from 'vitest';
import { ausfuehrbarerVorschlag, vorschlagKurz } from './vorschlag.js';

// v1480 — Werte wie im Realfall 16.10. (Vorgänge a734fddf, 2eb06cab, d02d9ac1)
const gibt = (n: string) => ['reminder', 'itsm', 'goe_charger'].includes(n);

describe('v1480 ausführbare Aktion eines Vorgangs', () => {
  it('nimmt die jüngste vorgeschlagene Aktion', () => {
    const v = ausfuehrbarerVorschlag([
      { art: 'vorgeschlagen', skill: 'reminder', aktion: 'set', params: { action: 'set', message: 'alt', triggerAt: '2026-10-15T09:00' }, beschreibung: 'alt', zeit: '2026-10-15T02:00:44Z' },
      { art: 'gemeldet', beschreibung: 'gemeldet', zeit: '2026-10-15T03:00:46Z' },
      { art: 'vorgeschlagen', skill: 'reminder', aktion: 'set', params: { action: 'set', message: 'Domain noahhabel.com verlängern', triggerAt: '2026-10-17T09:00' }, beschreibung: 'neu', zeit: '2026-10-15T10:00:36Z' },
    ], gibt);
    expect(v).toMatchObject({ ausfuehrbar: true, skill: 'reminder', aktion: 'set', beschreibung: 'neu' });
    expect(vorschlagKurz(v!)).toBe('reminder · set · message=Domain noahhabel.com verlängern · triggerAt=2026-10-17T09:00');
  });

  it('Platzhalter oder fehlendes Werkzeug → nicht ausführbar; ohne Aktion → undefined', () => {
    const p = ausfuehrbarerVorschlag([{ art: 'vorgeschlagen', skill: 'itsm', params: { action: 'update_incident', incident_id: '<id-aus-liste>' }, beschreibung: 'x', zeit: '1' }], gibt);
    expect(p).toMatchObject({ ausfuehrbar: false, grund: expect.stringContaining('Platzhalter') });
    expect(ausfuehrbarerVorschlag([{ art: 'zur_bestaetigung', skill: 'weg', params: { a: 1 }, beschreibung: 'x', zeit: '1' }], gibt)).toMatchObject({ ausfuehrbar: false });
    expect(ausfuehrbarerVorschlag([{ art: 'gemeldet', beschreibung: 'x', zeit: '1' }], gibt)).toBeUndefined();
    expect(ausfuehrbarerVorschlag([{ art: 'zur_bestaetigung', skill: 'goe_charger', params: { action: 'status' }, beschreibung: 'Wallbox', zeit: '1' }], gibt)).toMatchObject({ ausfuehrbar: true, aktion: 'status' });
  });
});
