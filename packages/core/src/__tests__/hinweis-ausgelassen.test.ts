import { describe, it, expect } from 'vitest';
import { istMetaText } from '../insights/hinweis-pruefung.js';
import { trenneAusgelassen, AUSGELASSEN_MARKER } from '../insights/ausgelassen.js';

// v1489 — Selbstauskünfte, die nach v1360/v1365/v1380/v1428 noch als Hinweis ankamen (Realfälle 13.–16.10.),
// kalibriert an 295 Reasoning-Hinweisen 16.09.–16.10.: 56 erkannt, kein echter Hinweis betroffen
describe('Selbstauskünfte nach v1428', () => {
  it('werden verworfen', () => {
    for (const t of [
      'Ich halte mich an die Regeln: keine bereits als erledigt markierten Vorgänge, keine vergangenen Ereignisse, keine erfundenen Daten.',
      '4. **Gamescom/Fußball-CC-Themen ohne Bezug** — keine Treffer, daher ausgelassen.',
      'Ich halte mich strikt an die Korrekturen, die Zeitregeln und die Faktenregel.',
      'Das Prompt enthält viele Regeln; ich halte mich an die Vorgaben und lasse alles weg, was bereits als erledigt oder als Routine markiert ist.',
      'Hier ist das Ergebnis, streng nach den Regeln (nur Auffälligkeiten mit Handlungsbedarf, keine erledigten/korrigierten Vorgänge).',
      'ich formuliere daraus Insights nach den Regeln (Korrekturen haben Vorrang, nur belegte Daten, keine erfundenen Daten).',
      'Keine weiteren Insights. Der Rest der Daten ist entweder Routine oder durch Korrekturen abgedeckt.',
      'Keine Aktionen vorgeschlagen.',
      'Die übrigen Daten enthalten nur bereits korrigierte oder erledigte Punkte.',
      'Die beiden HIGH-Auffälligkeiten sind echte Handlungspunkte. Die Korrekturen und Routine-Status habe ich ausgelassen.',
      'Relevante Information aus den RSS-Feeds: keine Treffer mit klarem Bezug zu deinem Profil — daher kein Insight.',
      'Ich kann diese Vorab-Analyse nicht sinnvoll in Insights übersetzen, weil der eingefügte Text mitten im JSON-Block abgeschnitten ist.',
    ]) expect(istMetaText(t), t).toBe(true);
  });

  it('echte Hinweise bleiben (Gegenprobe, auch mit Listennummer)', () => {
    for (const t of [
      '2. Heizölpreis-Pipeline fehlgeschlagen — GitLab meldet Pipeline #1761 als fehlgeschlagen und die Auto-DevOps-Pipeline wurde deaktiviert.',
      '3. **Wallbox go-echarger_402636 prüfen** – seit 31.08. nicht erreichbar (IP 192.168.1.175).',
      'Proxmox git-server RAM-Auslastung bei 95,8 % — Owner entscheidet über Maßnahmen (Frist 30.10. 15:30).',
      // Zusammenfassung mit Inhalt bleibt bewusst (sonst ginge der einzige Hinweis verloren)
      'Die einzige echte Auffälligkeit ist das fast leere Anthropic-Guthaben; alles andere ist entweder durch Korrekturen als erledigt markiert oder Routine.',
      'Keine Rückmeldung von der Wallbox seit 31.08. — Gerät prüfen.',
      '1. Ich empfehle, das Anthropic-Guthaben heute aufzuladen.',
    ]) expect(istMetaText(t), t).toBe(false);
  });
});

describe('Block „Ausgelassen“ (nur Protokoll)', () => {
  it('nach den Insights, vor den Aktionen: abgetrennt, Insights und Aktionen bleiben', () => {
    const a = `1. Heizölpreis-Pipeline #1761 fehlgeschlagen — Logs prüfen.\n\n${AUSGELASSEN_MARKER}\n- Gamescom: kein Bezug\n- Hausbatterie: laut Korrektur normal\n\n---ACTIONS---\n[{"type":"execute_skill"}]`;
    const r = trenneAusgelassen(a);
    expect(r.ausgelassen).toEqual(['Gamescom: kein Bezug', 'Hausbatterie: laut Korrektur normal']);
    expect(r.rest).toBe('1. Heizölpreis-Pipeline #1761 fehlgeschlagen — Logs prüfen.\n\n---ACTIONS---\n[{"type":"execute_skill"}]');
  });
  it('als Überschrift und am Ende; ohne Block bleibt alles', () => {
    expect(trenneAusgelassen('Hinweis A\n\n**Ausgelassen:**\nRSS ohne Treffer').rest).toBe('Hinweis A');
    expect(trenneAusgelassen('Hinweis A\n\n## Ausgelassen\nRSS ohne Treffer').ausgelassen).toEqual(['RSS ohne Treffer']);
    expect(trenneAusgelassen(`${AUSGELASSEN_MARKER}\nnichts Neues`).rest).toBe('');
    const ohne = 'Hinweis A — ausgelassen wurde nichts.\n\n---ACTIONS---\n[]';
    expect(trenneAusgelassen(ohne)).toEqual({ rest: ohne, ausgelassen: [] });
  });
});
