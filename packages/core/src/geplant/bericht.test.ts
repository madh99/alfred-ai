import { describe, it, expect } from 'vitest';
import { zeileLesen, standLesen, standSchreiben, berichtBauen, statusAus } from './bericht.js';

// v1465 — Prüfbericht nach fester Vorlage; Grundlage: echter Mac-Stand vom 15.10. (ältere Form)
const ALT = [
  '2058030293 | https://www.willhaben.at/iad/object?adId=2058030293 | Mac Studio M4 Max 64/1TB | 3300 EUR | online, unverändert',
  '2083107607 | https://www.willhaben.at/iad/object?adId=2083107607 | Mac Studio M4 Max 128/1TB | 5185 EUR | online, Preis gesenkt von 5190',
  '1053100579 | https://www.willhaben.at/iad/object?adId=1053100579 | Mac Studio M3 Ultra 256/2TB | 8200 EUR | nicht prüfbar (Status unklar), Preis unverändert',
  '1450404520 | https://www.willhaben.at/iad/object?adId=1450404520 | Mac Studio 2025 M4 Max 36/512 | 2450 EUR | online, außerhalb Filter (36 GB)',
  '789898944 | https://www.willhaben.at/iad/object?adId=789898944 | Mac mini M4 Pro 64/512 | 2400 EUR | verkauft (14.10. geprüft)',
].join('\n');

describe('v1465 Prüfbericht nach fester Vorlage', () => {
  it('liest die ältere Form: Link, Bezeichnung, Preis, Status und Notiz', () => {
    const e = standLesen(ALT);
    expect(e).toHaveLength(5);
    expect(e[0]).toEqual({ kennung: '2058030293', link: 'https://www.willhaben.at/iad/object?adId=2058030293', bezeichnung: 'Mac Studio M4 Max 64/1TB', wert: '3300 EUR', status: 'aktiv' });
    expect(e[2]!.status).toBe('nicht prüfbar');
    expect(e[3]).toMatchObject({ status: 'aktiv', notiz: 'außerhalb Filter (36 GB)' });
    expect(e[4]!.status).toBe('verkauft');
    expect(statusAus('nicht mehr abrufbar')).toBe('weg');
  });

  it('feste Form hin und zurück; Kopf- und Trennzeilen werden übersprungen', () => {
    const s = standSchreiben(standLesen(ALT));
    expect(s.split('\n')[0]).toBe('2058030293 | https://www.willhaben.at/iad/object?adId=2058030293 | Mac Studio M4 Max 64/1TB | 3300 EUR |  | aktiv |  | ');
    expect(standLesen(s)).toEqual(standLesen(ALT));
    expect(zeileLesen('Kennung | Link | Bezeichnung')).toBeUndefined();
    expect(zeileLesen('|---|---|')).toBeUndefined();
  });

  it('Änderungen zuerst, Tabelle aktueller Einträge, nicht prüfbar, Einschätzung — Status nur aus Daten', () => {
    const alt = standLesen(ALT).map(e => ({ ...e, seit: '2026-10-12' }));
    const neu = standLesen([
      '2058030293 | https://www.willhaben.at/iad/object?adId=2058030293 | Mac Studio M4 Max 64/1TB | 3300 EUR | Straßwalchen | aktiv |  | ',
      '2083107607 | | Mac Studio M4 Max 128/1TB | 5100 EUR | Wien 1020 | aktiv | AppleCare+ bis 2029 | ',
      '1053100579 | | Mac Studio M3 Ultra 256/2TB | 8200 EUR | Arlsdorf | aktiv |  | ',
      '1450404520 | | Mac Studio 2025 M4 Max 36/512 | 2450 EUR | Assling | verkauft |  | ',
      '789898944 | | Mac mini M4 Pro 64/512 | 2400 EUR | Wien | verkauft |  | ',
      '999 | https://www.willhaben.at/iad/object?adId=999 | Mac Studio M4 Max 128/2TB | 6500 EUR | Graz | aktiv |  | ',
    ].join('\n'));
    const r = berichtBauen({ alt, neu, einschaetzung: 'Der 128/1TB um 5100 EUR ist am interessantesten.', jetzt: new Date('2026-10-15T17:30:00Z') });
    expect(r.bericht.split('\n')[0]).toBe('## Änderungen');
    expect(r.bericht).toContain('📉 **Preis gesenkt:** [Mac Studio M4 Max 128/1TB](https://www.willhaben.at/iad/object?adId=2083107607) — 5185 EUR → **5100 EUR**');
    expect(r.bericht).toContain('❌ **Verkauft:** [Mac Studio 2025 M4 Max 36/512](https://www.willhaben.at/iad/object?adId=1450404520)');
    expect(r.bericht).toContain('🆕 **Neu:** [Mac Studio M4 Max 128/2TB](https://www.willhaben.at/iad/object?adId=999) — 6500 EUR, Graz');
    expect(r.bericht).not.toContain('Verkauft:** [Mac mini M4 Pro'); // schon gemeldet
    expect(r.bericht).toContain('## Aktuell (4)');
    expect(r.bericht).toContain('| Eintrag | Preis | Ort | Hinweis | bekannt seit |');
    expect(r.bericht).toContain('| [Mac Studio M3 Ultra 256/2TB](https://www.willhaben.at/iad/object?adId=1053100579) | 8200 EUR | Arlsdorf |  | 12.10. |'); // aktiv laut Daten, nicht „nicht prüfbar“
    expect(r.bericht).toContain('| 15.10. |'); // neu: seit heute
    expect(r.bericht.endsWith('## Einschätzung\n\nDer 128/1TB um 5100 EUR ist am interessantesten.')).toBe(true);
    expect(r.stand.map(e => e.kennung)).toEqual(['2058030293', '2083107607', '1053100579', '1450404520', '999']);
  });

  it('nicht genannte aktive Einträge bleiben als „nicht prüfbar“; ohne Änderungen ein klarer Satz', () => {
    const alt = standLesen(ALT);
    const r = berichtBauen({ alt, neu: [alt[0]!], jetzt: new Date('2026-10-15T07:00:00Z') });
    expect(r.bericht).toContain('Keine Änderungen seit dem letzten Lauf.');
    expect(r.bericht).toContain('## Nicht prüfbar');
    expect(r.bericht).toContain('[Mac Studio M4 Max 128/1TB](https://www.willhaben.at/iad/object?adId=2083107607) — in diesem Lauf nicht gemeldet');
    expect(r.stand.find(e => e.kennung === '789898944')).toBeUndefined(); // verkauft und nicht genannt: fällt heraus
    expect(r.bericht).not.toContain('## Einschätzung');
  });
  it('v1466 Einschätzung nur aus ihrem Block, an einer Satzgrenze gekürzt; Füllwörter nicht als Hinweis', async () => {
    const { einschaetzungAus, notizSauber } = await import('./bericht.js');
    const roh = '**Änderungen zum letzten Stand:** - Verkauft: …\n<<<EINSCHAETZUNG\n**Einschätzung:** Der 128/1TB ist am interessantesten.\nEINSCHAETZUNG>>>\n**Stand (8 Spalten):**\n<<<STAND\nA | | B | 1 EUR | | aktiv | | \nSTAND>>>';
    expect(einschaetzungAus(roh)).toBe('Der 128/1TB ist am interessantesten.');
    expect(einschaetzungAus('nur freier Text ohne Block')).toBeUndefined();
    const lang = `<<<EINSCHAETZUNG\n${'Ein ganzer Satz mit Inhalt. '.repeat(60)}\nEINSCHAETZUNG>>>`;
    const k = einschaetzungAus(lang)!;
    expect(k.length).toBeLessThanOrEqual(800);
    expect(k.endsWith('Inhalt.')).toBe(true);
    expect(notizSauber('unverändert')).toBeUndefined();
    expect(notizSauber('online, außerhalb Filter (36 GB)')).toBe('außerhalb Filter (36 GB)');
  });
});
