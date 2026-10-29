import { describe, it, expect } from 'vitest';
import { vorherSkript, nachherSkript, wartungsVerzeichnis } from './vorher-nachher.js';

// S2 — generischer Vorher-/Nachher-Vergleich (auf .92 live ausgeführt: 1 Container, 11 Ports, 14 Dienste, Vergleich ohne Abweichung)
describe('S2 Vorher/Nachher', () => {
  it('nur Verzeichnisse unter /var/lib/alfred-wartung, Marker, keine festen Namen', () => {
    expect(wartungsVerzeichnis('osupd-alfred_20261029_7d')).toBe('/var/lib/alfred-wartung/osupd-alfred_20261029_7d');
    expect(() => vorherSkript('/etc/x')).toThrow();
    const v = vorherSkript('/var/lib/alfred-wartung/probe1');
    expect(v).toContain('S2_VORHER_OK');
    expect(v).toContain('{{with index .State "Health"}}');
    const n = nachherSkript('/var/lib/alfred-wartung/probe1', 5);
    expect(n).toContain('ende=time.monotonic()+30'); // mindestens 30 s
    expect(n).toContain("a['health']=='healthy' and b['health']!='healthy'");
  });
});

describe('S4 naechsteNacht', () => {
  it('morgen 00:30 Wien mit Winter-/Sommerzeit-Versatz', async () => {
    const { naechsteNacht } = await import('./os-updates.js');
    expect(naechsteNacht(new Date('2026-11-04T09:00:00Z'))).toBe('2026-11-05T00:30:00+01:00');
    expect(naechsteNacht(new Date('2026-07-07T08:00:00Z'))).toBe('2026-07-08T00:30:00+02:00');
    expect(naechsteNacht(new Date('2026-10-24T09:00:00Z'))).toBe('2026-10-25T00:30:00+02:00'); // Umstellung erst um 03:00
  });
});
