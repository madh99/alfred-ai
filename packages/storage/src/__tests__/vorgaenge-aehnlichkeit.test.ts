import { describe, it, expect } from 'vitest';
import { titelAehnlichkeit, VORGANG_AEHNLICHKEIT_SCHWELLE } from '../repositories/vorgaenge-repository.js';

// v1185 — Realfall 05.10.: dasselbe Thema in anderem Wortlaut wurde zweimal Vorgang.
describe('titelAehnlichkeit', () => {
  it('gleiches Thema in anderem Wortlaut erreicht die Schwelle (Wortbestandteile zählen)', () => {
    const a = 'Kritische Systemfehler – E-Mail & Dateizugriff';
    const b = 'Kritische Systemfehler: E-Mail- und File-Zugriff blockiert (50%/75% Error-Rate)';
    expect(titelAehnlichkeit(a, b)).toBeGreaterThanOrEqual(VORGANG_AEHNLICHKEIT_SCHWELLE);
    expect(titelAehnlichkeit(b, a)).toBeGreaterThanOrEqual(VORGANG_AEHNLICHKEIT_SCHWELLE);
    expect(titelAehnlichkeit('Terrasse Batterie', 'Smart-Home-Sensor "Temp Terrasse" Batterie 0%')).toBeGreaterThanOrEqual(VORGANG_AEHNLICHKEIT_SCHWELLE);
  });
  it('zwei Sensoren mit gleichem Verb bleiben zwei Vorgänge', () => {
    expect(titelAehnlichkeit('Batterie Terrasse tauschen', 'Batterie Wohnzimmer tauschen')).toBeLessThan(VORGANG_AEHNLICHKEIT_SCHWELLE);
    expect(titelAehnlichkeit('Batterie Sensor Terrasse tauschen', 'Batterie Sensor Wohnzimmer tauschen')).toBeLessThan(VORGANG_AEHNLICHKEIT_SCHWELLE);
  });
  it('verschiedene Themen liegen darunter', () => {
    expect(titelAehnlichkeit('Smart-Home-Sensor "Temp Terrasse" Batterie 0%', 'Proxmox-Server git-server RAM-Auslastung 95,1%')).toBe(0);
    expect(titelAehnlichkeit('9 unbeantwortete E-Mails mit Follow-up-Bedarf', 'Kritische Systemfehler – E-Mail & Dateizugriff')).toBe(0);
  });
  it('leere, kurze oder nur ein gemeinsames Wort ergeben 0', () => {
    expect(titelAehnlichkeit('', 'x')).toBe(0);
    expect(titelAehnlichkeit('ab cd', 'ab cd')).toBe(0);
    expect(titelAehnlichkeit('Terrasse Batterie', 'Terrasse Batterie')).toBe(1);
  });
});
