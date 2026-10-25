import { describe, it, expect } from 'vitest';
import { zeilenUnterschied, fassungAusTitel, vergleichsBasis } from './fassung-vergleich.js';

describe('v1657 Fassungsvergleich', () => {
  it('liefert nur geänderte Zeilen mit ihrer Abschnittsüberschrift', () => {
    const alt = '# Zielarchitektur (Version 6)\n\n## Gruppen\n- Tresor: VM\n- Web: bleibt\n\n## Netze\n| VLAN | Netz |\n| 825 | Betrieb |\n';
    const neu = '# Zielarchitektur (Version 8)\n\n## Gruppen\n- Tresor: VM\n- Web: docker-web-01\n\n## Netze\n| VLAN | Netz |\n| 825 | Betrieb |\n| 826 | Web |\n';
    expect(zeilenUnterschied(alt, neu)).toEqual([
      { art: 'weg', zeile: '# Zielarchitektur (Version 6)' },
      { art: 'neu', zeile: '# Zielarchitektur (Version 8)' },
      { art: 'abschnitt', zeile: '## Gruppen' },
      { art: 'weg', zeile: '- Web: bleibt' },
      { art: 'neu', zeile: '- Web: docker-web-01' },
      { art: 'abschnitt', zeile: '## Netze' },
      { art: 'neu', zeile: '| 826 | Web |' },
    ]);
  });

  it('gleiche Fassungen ergeben keinen Unterschied', () => {
    expect(zeilenUnterschied('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('Version aus dem Titel und Vergleichsbasis (zuletzt angenommen, sonst vorige)', () => {
    expect(fassungAusTitel('Zielarchitektur Dockerhost auf neue Docker-VMs aufteilen v8')).toBe(8);
    expect(fassungAusTitel('Bestandsbericht')).toBeUndefined();
    expect(vergleichsBasis(8, [{ entscheidung: 'ueberarbeiten', architekturVersion: 3 }, { entscheidung: 'annehmen', architekturVersion: 6 }])).toEqual({ version: 6, angenommen: true });
    expect(vergleichsBasis(3, [])).toEqual({ version: 2, angenommen: false });
    expect(vergleichsBasis(1, [])).toBeUndefined();
  });
});
