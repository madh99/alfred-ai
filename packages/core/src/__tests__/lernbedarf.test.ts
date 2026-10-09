import { describe, it, expect } from 'vitest';
import { istAbsage, lernbedarfAusAbsage, lernbedarfAusSkillFehler, istRueckfrageOderBefehl } from '../vorgaenge/lernbedarf.js';

// v1335 — Owner-Review 09.10.: Rückfragen und Befehle aus Gerätesitzungen sind kein Lernbedarf
describe('istRueckfrageOderBefehl (v1335)', () => {
  it('erkennt Rückfragen, Kurztexte und Befehle', () => {
    for (const t of ['warum setzt du es nicht um ?', 'dann mach doch weiter !', 'ich warte', '/verlauf', 'ok danke', 'und jetzt?', 'kannst du?']) expect(istRueckfrageOderBefehl(t)).toBe(true);
    for (const t of ['Wie viele Schritte bin ich heute laut meiner Garmin-Uhr gegangen?', 'Home Assistant, ist alles in Ordnung? Wie viel Strom haben wir heute verbraucht?']) expect(istRueckfrageOderBefehl(t)).toBe(false);
  });
  it('legt bei einer Rückfrage keinen Lernbedarf an, bei einer echten Frage schon', () => {
    const absage = 'Das kann ich nicht, mir fehlt der Zugriff.';
    expect(lernbedarfAusAbsage('warum setzt du es nicht um ?', absage)).toBeUndefined();
    expect(lernbedarfAusAbsage('/verlauf', absage)).toBeUndefined();
    expect(lernbedarfAusAbsage('Wie viele Schritte bin ich heute laut meiner Garmin-Uhr gegangen?', absage)?.titel).toContain('Garmin');
  });
});

// v1207 — Jarvis Schleife 3: Lücke → Fähigkeit.
describe('istAbsage', () => {
  it('erkennt deutsche und englische Absagen, nicht aber normale Antworten', () => {
    expect(istAbsage('Das kann ich leider nicht, mir fehlt der Zugriff auf den Kalender.')).toBe(true);
    expect(istAbsage("I can't access that mailbox.")).toBe(true);
    expect(istAbsage('Dein BMW steht zu Hause, Akku 30 %.')).toBe(false);
  });
  it('v1215 Realfall: langer Lagebericht mit „nicht verfügbar" tief im Text ist keine Absage', () => {
    const lage = '**Die Gesamtlage: BMW-Zugang funktioniert wieder, zwei Infrastrukturwarnungen bleiben offen.** - **BMW:** Autorisierung erfolgreich. Letzter Fahrzeugstand: 30 % Akku, 137 km Reichweite, verriegelt. - **Infrastruktur:** Der git-server liegt bei rund 96 % RAM-Auslastung. Außerdem ist der UniFi-Access-Point „AC Mesh" nicht verbunden. Beide Vorfälle sind weiterhin offen. - **aWATTar:** Der Rechnungscheck ist noch blockiert: Der gewünschte Outlook-Account ist nicht verfügbar, der E-Mail-Skill ist deaktiviert. - **Domains:** Zahlungs- und Verlängerungsstatus bei easyname, nic.at und pinkribbons.club müssen geprüft werden. **Priorität:** Zuerst den git-server prüfen.';
    expect(lage.length).toBeGreaterThan(500);
    expect(istAbsage(lage)).toBe(false);
    expect(istAbsage('Dazu habe ich keinen Zugriff. ' + 'x'.repeat(600))).toBe(true); // Absage im Kopf zählt auch bei langem Text
    expect(lernbedarfAusAbsage('zu der gesamtlage ?', lage)).toBeUndefined();
  });
});

describe('lernbedarfAusAbsage', () => {
  it('baut Titel, Ziel, nächsten Schritt, Dedupe-Schlüssel und Kategorie aus Frage und Absage', () => {
    const v = lernbedarfAusAbsage('Was war das Outlook-Problem heute?', 'Dazu habe ich keinen Zugriff auf das Postfach.\nSag mir, was ich prüfen soll.')!;
    expect(v.titel).toBe('Lernbedarf: „Was war das Outlook-Problem heute?" konnte ich nicht beantworten');
    expect(v.ziel).toContain('Antwort (Absage): Dazu habe ich keinen Zugriff auf das Postfach.');
    expect(v.dedupeKey.startsWith('lernbedarf:absage:')).toBe(true);
    expect(v.kategorie).toBe('email');
    expect(lernbedarfAusAbsage('Was war das Outlook-Problem heute?', 'Hier ist die Übersicht …')).toBeUndefined();
    expect(lernbedarfAusAbsage('ok', 'kann ich nicht')).toBeUndefined();
  });
  it('gleiche Frage in anderer Reihenfolge der Wörter → gleicher Schlüssel', () => {
    const a = lernbedarfAusAbsage('Outlook Problem heute?', 'geht nicht')!;
    const b = lernbedarfAusAbsage('Problem heute Outlook?', 'geht nicht')!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

describe('lernbedarfAusSkillFehler', () => {
  it('nennt Skill, Fehlerklasse, Ort und den beobachteten Umweg', () => {
    const v = lernbedarfAusSkillFehler({ failedSkill: 'email', errorClass: 'AUTH', scope: 'outlook', workaroundSteps: ['Token erneuert', 'erneut versucht'], finalSuccess: true });
    expect(v.titel).toBe('Lernbedarf: Skill „email" scheitert AUTH bei outlook');
    expect(v.ziel).toBe('Beobachteter Umweg: Token erneuert → erneut versucht');
    expect(v.naechsterSchritt).toMatch(/Runbook bestätigen/);
    expect(v.dedupeKey).toBe('lernbedarf:skill:email:outlook:auth');
    expect(v.kategorie).toBe('alfred');
  });
});
