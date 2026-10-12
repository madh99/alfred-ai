import { describe, it, expect } from 'vitest';
import { entscheideMeldung, istStilleAnweisung, kennungenAus } from '../geplant/meldung.js';

// v1368 — Realfall 11.10.: aWATTar-Rechnung 09/2026 verarbeitet, Meldung verworfen, weil der Prompt „nichts" enthielt.
const PROMPT = 'Führe den aWATTar-Rechnungscheck VOLLSTÄNDIG aus. … 1) Duplikat-Check: … Wenn bereits Status "verarbeitet" mit Betrag UND PDF-Pfad vorhanden: nichts erneut verarbeiten, nur kurz melden. … 6) Kurze Benachrichtigung senden mit: Monat, Rechnungsnummer, Betrag, Verbrauch, Durchschnittspreis, PDF-Ablagepfad. Wenn keine neue Rechnung gefunden wird: kurz melden, welche letzte bekannte aWATTar-Rechnung im Memory steht (Monat, Nummer, Status).';
const NEU = '**aWATTar Stromrechnung September 2026 — verarbeitet**\n- Rechnungsnummer: 2026741757\n- Zeitraum: 01.09.–30.09.2026\n- Betrag (Brutto): 46,28 €\n- Verbrauch: 94,75 kWh\n- PDF: /root/alfred/Rechnungen/Strom/2026741757-awattar-invoice.pdf';
// echte Meldung 11.09. 22:03 (gekürzt)
const NICHTS_NEUES = '🔋 aWATTar-Rechnungscheck VOLLSTÄNDIG — 11. September 2026\n✅ Status: KEINE NEUE RECHNUNG SEIT JULI 2026\nDie Juli-Rechnung (2026693712) wurde am 23. August 2026 vollständig verarbeitet, Betrag 23,07 €.';

describe('Stille-Anweisung', () => {
  it('nur ausdrücklich — „nichts erneut verarbeiten" ist keine', () => {
    expect(istStilleAnweisung(PROMPT)).toBe(false);
    expect(istStilleAnweisung('Prüfe die Backups. Wenn alles ok ist, antworte NICHTS.')).toBe(true);
    expect(istStilleAnweisung('Prüfe die Zertifikate; sonst keine Nachricht.')).toBe(true);
    expect(istStilleAnweisung('Nur bei Problemen melden.')).toBe(true);
  });
});

describe('kennungenAus', () => {
  it('Rechnungsnummer und Betrag, keine Daten oder kWh', () => {
    expect(kennungenAus(NEU).sort()).toEqual(['n:2026741757', '€:46,28']);
  });
});

describe('entscheideMeldung', () => {
  it('neue Rechnung wird gemeldet (Realfall 11.10.)', () => {
    const e = entscheideMeldung({ text: NEU, prompt: PROMPT, istFehler: false, bekannt: new Set(['n:2026714680', '€:25,74']) });
    expect(e).toMatchObject({ senden: true, grund: 'neue Kennungen' });
  });
  it('dieselbe Rechnung um 22:00 noch einmal → still', () => {
    const e = entscheideMeldung({ text: NEU, prompt: PROMPT, istFehler: false, bekannt: new Set(kennungenAus(NEU)) });
    expect(e.senden).toBe(false);
  });
  it('„keine neue Rechnung, letzte ist …" wiederholt Bekanntes → still; auch mit ❌ „nicht gefunden"', () => {
    const bekannt = new Set(kennungenAus(NICHTS_NEUES));
    expect(entscheideMeldung({ text: NICHTS_NEUES, prompt: PROMPT, istFehler: false, bekannt }).senden).toBe(false);
    expect(entscheideMeldung({ text: `❌ Keine Juli-Rechnung gefunden.\n${NICHTS_NEUES}`, prompt: PROMPT, istFehler: false, bekannt }).senden).toBe(false);
  });
  it('echtes Problem ohne Neues wird gemeldet; Fehler des Laufs immer', () => {
    const bekannt = new Set(kennungenAus(NICHTS_NEUES));
    expect(entscheideMeldung({ text: `⚠️ Outlook-Account nicht verfügbar. ${NICHTS_NEUES}`, prompt: PROMPT, istFehler: false, bekannt }).grund).toBe('Alarm');
    expect(entscheideMeldung({ text: 'Scheduled action failed: timeout', prompt: PROMPT, istFehler: true, bekannt }).senden).toBe(true);
  });
  it('ausdrückliche Stille: nur bei Alarm; ohne Kennungen wie bisher melden', () => {
    expect(entscheideMeldung({ text: 'Alle Backups grün.', prompt: 'Wenn alles ok ist, antworte NICHTS.', istFehler: false, bekannt: new Set() }).senden).toBe(false);
    expect(entscheideMeldung({ text: 'Backup von git-server fehlgeschlagen', prompt: 'Wenn alles ok ist, antworte NICHTS.', istFehler: false, bekannt: new Set() }).senden).toBe(true);
    expect(entscheideMeldung({ text: 'Heute 18 °C und sonnig.', prompt: 'Wetter morgens melden.', istFehler: false, bekannt: new Set() }).senden).toBe(true);
  });
});
