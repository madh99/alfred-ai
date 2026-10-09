import { describe, it, expect } from 'vitest';
import { neuesteAppDatei, istAppPlattform } from './app-releases.js';

describe('v1322 App-Releases — neueste Datei je Plattform', () => {
  it('erkennt die Namensmuster und wählt die höchste Version', () => {
    const w = ['Alfred-1.0.0-setup.exe', 'Alfred-1.0.2-setup.exe', 'Alfred-1.0.10-setup.exe', 'Alfred-1.0.10-setup.exe.sha256', 'notizen.txt'];
    expect(neuesteAppDatei('windows', w)).toEqual({ datei: 'Alfred-1.0.10-setup.exe', version: '1.0.10' });
    expect(neuesteAppDatei('macos', ['Alfred-1.0.1.dmg', 'Alfred-1.0.0.dmg'])).toEqual({ datei: 'Alfred-1.0.1.dmg', version: '1.0.1' });
    expect(neuesteAppDatei('linux', ['alfred_1.0.1_amd64.deb', 'alfred_1.0.1_arm64.deb'])).toEqual({ datei: 'alfred_1.0.1_amd64.deb', version: '1.0.1' });
  });
  it('fremde Dateien und falsche Plattform ergeben nichts', () => {
    expect(neuesteAppDatei('windows', ['Alfred-1.0.0.dmg', 'setup.exe'])).toBeUndefined();
    expect(neuesteAppDatei('linux', [])).toBeUndefined();
  });
  it('Plattform-Prüfung', () => {
    expect(istAppPlattform('windows')).toBe(true);
    expect(istAppPlattform('ios')).toBe(false);
  });
});
