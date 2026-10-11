import { describe, it, expect } from 'vitest';
import { istMetaText, texteAusJson, istThemenWiederholung, entferneWiederholungen, ankerAus } from '../insights/hinweis-pruefung.js';
import { widersprichtWeltmodell, anbieterDatenlage } from '../vorgaenge/faktenpruefung.js';

// v1360 — Realfälle 11.10. (Owner 12.10.: Hinweise reparieren): Vorreden, rohes JSON, „Claude-API gesperrt" 9×
describe('istMetaText', () => {
  it('Vorreden und Überschriften des Modells', () => {
    for (const t of [
      'Hier sind die Insights für heute (Sonntag, 11.10.2026, 09:00). Ich nenne nur Zeitangaben, die wörtlich in den Daten stehen.',
      'Insights (Handlungsbedarf zuerst, dann relevante Information):',
      'Die drei Vorab-Auffälligkeiten sind:',
      'Ich habe die Vorab-Analyse und die Datenlage durchgesehen. Die drei HIGH-Punkte sind aktuell relevant.',
      'Die Systemvorgaben sind umfangreich, aber die Aufgabe ist klar: aus den Auffälligkeiten Insights formulieren.',
      'Hinweis: Die Insight-Tracking-Liste zeigt die Anthropic-Meldung bereits als offen.',
      '**Aktionen:**',
      '**Insights**',
    ]) expect(istMetaText(t), t).toBe(true);
  });
  it('echte Hinweise bleiben', () => {
    expect(istMetaText('1. **Microsoft Power Platform: Kapazität erschöpft — Frist Sa 17.10. 13:31.** Database, Log und File sind voll.')).toBe(false);
    expect(istMetaText('- Unifi „AC Mesh" ist nicht verbunden: Gerät prüfen (Stromversorgung, Reichweite).')).toBe(false);
    expect(istMetaText('Hinweis: Das Garagentor steht seit 2 h offen.')).toBe(false);
  });
});

describe('texteAusJson', () => {
  it('rettet die Texte einer JSON-Antwort, kein JSON → null, kaputtes JSON → leer', () => {
    const roh = '{\n  "insights": [\n    { "type": "handlungsbedarf", "urgency": "urgent", "text": "Anthropic hat deinen Claude-API-Zugang deaktiviert (Mail 11.10., 15:31)." },\n    { "type": "info", "text": "DDNSS.de-Übernahme: Mail vom 10.10. beantworten." }\n  ]\n}';
    expect(texteAusJson(roh)).toEqual(['Anthropic hat deinen Claude-API-Zugang deaktiviert (Mail 11.10., 15:31).', 'DDNSS.de-Übernahme: Mail vom 10.10. beantworten.']);
    expect(texteAusJson('Normaler Hinweis')).toBeNull();
    expect(texteAusJson('{ "insights": [ kaputt')).toEqual([]);
  });
});

describe('Wiederholungen', () => {
  const erste = '**1. Handlungsbedarf · Dringend:** Anthropic meldet deinen Claude-API-Zugang als deaktiviert (Mail 11.10. 15:31). Der neue Beleg vom 11.10. 16:42 zeigt eine Zahlung.';
  it('die Anthropic-Serie wird ab der zweiten Meldung erkannt', () => {
    for (const t of [
      '**1. [Dringend] Anthropic Claude-API-Zugang klären:** Die Mail vom 11.10. 15:31 meldet den Zugang als deaktiviert, der Zahlungsbeleg vom 11.10. 16:42 zeigt jedoch eine Zahlung.',
      '1. **Claude-API-Zugang deaktiviert (dringend)** – Anthropic hat laut Mail vom 11.10. 15:31 den API-Zugang gesperrt ("Handlung erforderlich"). Receipt vom 11.10. 16:42 prüfen.',
    ]) expect(istThemenWiederholung(t, [erste]), t).not.toBeNull();
  });
  it('verschiedene Themen mit gemeinsamen Gattungswörtern bleiben getrennt', () => {
    const shelly = '- Home Assistant: Die Shelly-1PM-Schaltaktoren (68C63AFADBA8) melden Überlast, Überhitzung und sind nicht verfügbar.';
    const plug = '- Home Assistant: 9 PlugSG3-it-garge-Entitäten (Überhitzung, Überlast, Überspannung, Überstrom) sind nicht verfügbar.';
    expect(istThemenWiederholung(plug, [shelly])).toBeNull();
    const mesh = '2. **Handlungsbedarf · Dringend:** UniFi meldet den Access Point „AC Mesh" als nicht verbunden.';
    const tv = '- Prüfen: Die Entität „[LG] webOS TV OLED55B7V" ist neu nicht verfügbar (626 unavailable insgesamt).';
    expect(istThemenWiederholung(mesh, [tv])).toBeNull();
  });
  it('Sammelhinweis: nur der bekannte Punkt fällt weg, der neue bleibt', () => {
    const ram = '4. **git-server RAM bei 95,7 %** — Die Auslastung ist hoch; prüfen, welcher Prozess den Speicher hält.';
    const sammel = '- Home Assistant prüfen: 36 PV-/Kraftwerk-Entitäten (u. a. daily_pv_carport_energy) liefern keine Werte.\n- git-server RAM weiter bei 95,7 % — Prozess prüfen, bevor der Server tauscht.';
    const r = entferneWiederholungen(sammel, [ram]);
    expect(r.text).toBe('- Home Assistant prüfen: 36 PV-/Kraftwerk-Entitäten (u. a. daily_pv_carport_energy) liefern keine Werte.');
    expect(r.entfernt).toHaveLength(1);
    expect(entferneWiederholungen(ram, [ram]).text).toBeNull();
  });
  it('Anker: Datum, Uhrzeit, Prozent, Domain, Eigenname, Kennung', () => {
    expect([...ankerAus('DDNSS.de Mail 10.10. 15:31, 95,7 %, noahhabel.com, UniFi, 68C63AFADBA8')].sort()).toEqual(
      ['d:10.10', 'h:ddnss.de', 'h:noahhabel.com', 'n:ddnss', 'n:unifi', 'p:95.7', 't:15:31', 'x:68C63AFADBA8'].sort());
  });
});

describe('Fakten-Gegenprobe Modell-Anbieter', () => {
  const jetzt = new Date('2026-10-12T00:00:00Z');
  const puls = [
    { tier: 'strong', provider: 'anthropic', letzterErfolg: '2026-10-11T23:30:00Z' },
    { tier: 'fast', provider: 'anthropic', letzterErfolg: '2026-10-11T22:00:00Z' },
    { tier: 'default', provider: 'openai', letzterErfolg: '2026-10-11T10:00:00Z', gestoertSeit: '2026-10-11T11:00:00Z' },
  ];
  const hole = (k: string) => (k.startsWith('llm-') ? anbieterDatenlage(puls, k.slice(4), jetzt) : undefined);
  it('„Claude-API-Zugang deaktiviert" widerspricht dem Puls, solange Claude-Aufrufe gelingen', () => {
    const w = widersprichtWeltmodell('1. **Claude-API-Zugang deaktiviert** – Anthropic hat den API-Zugang laut Mail vom 11.10. deaktiviert.', hole);
    expect(w?.sektion).toBe('llm-anthropic');
    expect(w?.grund).toContain('NORMAL');
  });
  it('bei echter Störung kein Widerspruch; Claude-Code-Aufträge und HA-Automationen sind keine Anbieter-Behauptung', () => {
    expect(widersprichtWeltmodell('OpenAI-Zugang gesperrt: Aufrufe scheitern seit 13:00.', hole)).toBeNull();
    expect(widersprichtWeltmodell('Claude-Code-Auftrag auf dem Mac: Satellit nicht erreichbar.', hole)).toBeNull();
    expect(widersprichtWeltmodell('Home Assistant: Automation „Licht Gang" deaktiviert.', (k) => (k === 'smarthome' ? '**Datenlage:** NORMAL' : undefined))).toBeNull();
  });
  it('ohne Puls-Daten keine Aussage', () => {
    expect(anbieterDatenlage([], 'anthropic', jetzt)).toBeUndefined();
  });
});
