import { describe, it, expect } from 'vitest';
import { ausfuehrbarerVorschlag, eingabeFehler, vorschlagKurz } from './vorschlag.js';

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

// v1537 — Realfall 21.10. Vorgang f4ad7c1b: proxmox vm_status mit {"vm":"git-server"}, viermal „Missing required vmid“
describe('v1537 Prüfung und keine Wiederholung', () => {
  const proxmox = {
    metadata: { inputSchema: { properties: { action: { type: 'string', enum: ['vm_status', 'list_vms'] }, vmid: { type: 'number' }, vm: { type: 'string' } }, required: ['action'] } },
    pruefeEingabe: (i: Record<string, unknown>) => (i.action === 'vm_status' && i.vmid === undefined && !i.vm ? 'vm_status braucht vmid oder vm (Name)' : undefined),
  };
  const ohneEigene = { metadata: { inputSchema: { properties: { n: { type: 'number' } }, required: ['a'] } } };
  const p = { action: 'vm_status', vm: 'git-server' };
  const real = [
    { art: 'vorgeschlagen', skill: 'proxmox', params: p, beschreibung: 'Proxmox git-server RAM-Auslastung prüfen', zeit: '2026-10-21T13:30:50.294Z' },
    { art: 'zur_bestaetigung', skill: 'proxmox', params: p, beschreibung: 'Proxmox git-server RAM-Auslastung prüfen', zeit: '2026-10-21T13:30:50.439Z' },
    { art: 'fehlgeschlagen', skill: 'proxmox', params: p, beschreibung: 'vom Owner ausgeführt (App): Proxmox git-server RAM-Auslastung prüfen', ergebnis: 'Missing required "vmid" parameter', zeit: '2026-10-21T13:33:45.764Z' },
    { art: 'fehlgeschlagen', skill: 'proxmox', params: p, beschreibung: 'vom Owner ausgeführt (App): vom Owner ausgeführt (App): Proxmox git-server RAM-Auslastung prüfen', ergebnis: 'Missing required "vmid" parameter', zeit: '2026-10-21T13:34:18.453Z' },
  ];

  it('eingabeFehler: Pflichtfeld, Aktion, Zahl, eigene Prüfung', () => {
    expect(eingabeFehler(proxmox, { action: 'vm_status' })).toContain('braucht vmid');
    expect(eingabeFehler(proxmox, { action: 'loeschen' })).toContain('unbekannten Wert');
    expect(eingabeFehler(proxmox, p)).toBeUndefined();
    expect(eingabeFehler(proxmox, { action: 'vm_status', vmid: 'git-server' })).toBeUndefined(); // Skill löst Namen selbst auf
    expect(eingabeFehler(ohneEigene, { n: 1 })).toContain('„a“ fehlt');
    expect(eingabeFehler(ohneEigene, { a: 'x', n: 'zwölf' })).toContain('Zahl');
    expect(eingabeFehler(ohneEigene, { a: 'x', n: '12' })).toBeUndefined();
  });

  it('Parameterfehler + jetzt gültige Prüfung → erneut ausführbar, Beschreibung ohne gestapelte Vorsilben', () => {
    const v = ausfuehrbarerVorschlag(real, () => true, () => proxmox);
    expect(v).toMatchObject({ ausfuehrbar: true, params: p, beschreibung: 'Proxmox git-server RAM-Auslastung prüfen' });
  });

  it('ohne Prüfung bzw. bei anderem Fehler → nicht wiederholen', () => {
    expect(ausfuehrbarerVorschlag(real, () => true)).toMatchObject({ ausfuehrbar: false, grund: expect.stringContaining('Gleiche Aktion schlug zuletzt fehl') });
    const anders = [...real, { art: 'fehlgeschlagen', skill: 'proxmox', params: p, beschreibung: 'x', ergebnis: 'Proxmox API 500', zeit: '2026-10-21T20:04:15Z' }];
    expect(ausfuehrbarerVorschlag(anders, () => true, () => proxmox)).toMatchObject({ ausfuehrbar: false, grund: expect.stringContaining('Proxmox API 500') });
  });

  it('unvollständiger Vorschlag → Grund statt Ausführen; neuer Vorschlag nach Fehlschlag gibt wieder frei', () => {
    expect(ausfuehrbarerVorschlag([{ art: 'vorgeschlagen', skill: 'proxmox', params: { action: 'vm_status' }, beschreibung: 'x', zeit: '1' }], () => true, () => proxmox))
      .toMatchObject({ ausfuehrbar: false, grund: 'Vorschlag unvollständig: vm_status braucht vmid oder vm (Name)' });
    const neu = [...real, { art: 'vorgeschlagen', skill: 'proxmox', params: { action: 'vm_status', vmid: 105 }, beschreibung: 'neu', zeit: '2026-10-22T08:00:00Z' }];
    expect(ausfuehrbarerVorschlag(neu, () => true, () => proxmox)).toMatchObject({ ausfuehrbar: true, params: { vmid: 105 } });
  });
});
