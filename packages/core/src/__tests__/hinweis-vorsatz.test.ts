import { describe, it, expect } from 'vitest';
import { istMetaText, ohneMetaVorsatz } from '../insights/hinweis-pruefung.js';

// v1365 — Realfälle 12.10., die nach v1360 noch als Hinweis zugestellt wurden
describe('Selbstauskünfte nach v1360', () => {
  it('werden verworfen', () => {
    for (const t of [
      'Die Hausbatterie-Meldung (SoC 18 %) habe ich bewusst weggelassen, da du bestätigt hast, dass sie per EMS gesteuert wird und lädt.',
      'Nicht als Insight übernommen: Hausbatterie-SoC (EMS-Korrektur), Shelly-Warnung (Korrektur), BMW-Zustandsdaten (normal), PV-Entitäten (Nacht, erwartet), Anthropic-Rechnung als Zahlungsproblem (Rechnung/Quittung, nicht als Fehler gewertet).',
      'Insights sind nicht immer leicht aus dem Datenstand zu gewinnen, deshalb hier meine Auswertung der drei Vorab-Auffälligkeiten gegen die aktuellen Korrekturen und Daten:',
      'Keine Artikel im RSS-Feed passen klar zu deinem Profil; ich lasse diesen Punkt daher weg.',
      'Keine passenden RSS-Artikel mit klarem Profilbezug in den aktuellen Daten.',
    ]) expect(istMetaText(t), t).toBe(true);
  });

  it('echte Hinweise der Woche bleiben (Gegenprobe)', () => {
    for (const t of [
      '3. **Wallbox go-echarger_402636 prüfen** – seit 31.08. nicht erreichbar (IP 192.168.1.175). Der Fehler ist persistent; Erreichbarkeit im Netz bzw. am Gerät prüfen.',
      '- **Ladeplanung nachziehen:** Das einzige hinterlegte Netzladefenster liegt im Juli und ist abgelaufen.',
      '3. **Fenster von Lena prüfen:** Laut Analyse seit 12:01 offen, Lena ist abwesend.',
      '- **proxmox git-server (RAM 95,5 %):** Auslastung prüfen (welcher Prozess/Container belegt den Speicher).',
      'Hinweis: Das Garagentor steht seit 2 h offen.',
      'Keine Rückmeldung von der Wallbox seit 31.08. — Gerät prüfen.',
    ]) {
      expect(istMetaText(t), t).toBe(false);
      expect(ohneMetaVorsatz(t), t).toBe(t);
    }
  });
});

describe('ohneMetaVorsatz', () => {
  it('Leerlauf-Vorsatz weg, Inhalt bleibt (Realfall 12.10. 08:00)', () => {
    const t = 'Keine passenden RSS-Treffer mit klarem Bezug zu deinem Profil in diesem Lauf. (Hinweis: Die Studenten-Demo am 13.10. mit gesperrtem Wiener Ring betrifft Wien-Fahrten – falls relevant, bitte beachten: https://kurier.at/chronik/wien/demo-13-oktober-wien-ring-uni)';
    expect(ohneMetaVorsatz(t)).toBe('Die Studenten-Demo am 13.10. mit gesperrtem Wiener Ring betrifft Wien-Fahrten – falls relevant, bitte beachten: https://kurier.at/chronik/wien/demo-13-oktober-wien-ring-uni');
  });

  it('ohne Inhalt danach bleibt der Text (und wird als Vorrede verworfen)', () => {
    const t = 'Keine Artikel im RSS-Feed passen klar zu deinem Profil; ich lasse diesen Punkt daher weg.';
    expect(ohneMetaVorsatz(t)).toBe(t);
    expect(istMetaText(t)).toBe(true);
  });
});

// v1380 — Realfall 12.10. 14:01: Abschnittsüberschriften kamen als eigene Hinweise an
describe('Überschriften ohne Inhalt', () => {
  it('werden verworfen', () => {
    for (const t of ['**Relevante Information**', '**Handlungsbedarf**', 'Weitere Hinweise:', 'Nächste Schritte', 'Übersicht (heute)', 'Empfehlung', 'Beobachtungen', 'Relevante Informationen']) expect(istMetaText(t), t).toBe(true);
  });
  it('kurze echte Hinweise bleiben', () => {
    for (const t of ['Garagentor offen', 'Status: Wallbox offline seit 31.08.', 'Handlungsbedarf: Domain noahhabel.at läuft am 15.10. ab']) expect(istMetaText(t), t).toBe(false);
  });
});
