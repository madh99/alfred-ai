# Stufe „ultra“ (Claude Fable 5.2) — Spec

Stand 21.11.2026, **vom Owner freigegeben 21.11.2026** („ok wie vorgeschlagen“): O1 Gegenprüfung ab Risiko high, O2 Gründlichkeit high (max nur ausdrücklich). Owner-Vorgaben: Variante „Eskalation + Gegenprüfung“, auch in den Apps verfügbar. Umsetzung in Releases U1 → U3/U2.1 → U2.2 → U2.3 → U4, je mit Live-Beweis.

## Ziel

Eine Stufe oberhalb von `strong` für wenige Aufgaben mit hohem Gewicht. Der doppelte Preis (Fable 5.2 $8/$40 gegenüber Opus 5.5 $4/$20) fällt nur an, wo ein objektiver Auslöser vorliegt oder der Owner es ausdrücklich will. Die Auswahl ist deterministisch und modellunabhängig, kein Modell schätzt die „Schwierigkeit“ selbst ein (Architektur-Grundsatz).

## Ist-Stand (belegt, Bestandsaufnahme 21.11.)

- Stufen: `ModelTier` in `packages/types/src/llm.ts:17`, Konfiguration `packages/config/src/schema.ts:77` und ENV `loader.ts:53-61`, Router `packages/llm/src/model-router.ts` (`TIERS` Z. 14, Rückfall auf `default` in `resolve()` Z. 120-132, Fehlerkette `FALLBACK_ORDER` Z. 60, Gründlichkeit `TIER_DEFAULT_EFFORT` Z. 69-74, App-Liste `stufen()` Z. 497-505).
- Infrastruktur-Planung (`change_planen`, `architektur_vorschlagen`, `change_aendern`, Korrekturen) wählt keine eigene Stufe. Sie läuft in der Stufe der Nachricht, im Faden also `default` (gpt-6.2-sol).
- Pro Nachricht ist eine Stufe wählbar: HTTP-Feld `tier` (Whitelist `messaging/src/adapters/http.ts:6691`), CLI `/tier`, App-Auswahl `apps/flutter/lib/sitzung_oberflaeche.dart:359-380` (Automatisch, Schnell, Normal, Stark).
- Die App zeigt „Modell · Gründlichkeit“ der letzten Antwort über `GET /api/geraete/stufen` (`antwort_aktionen.dart`). Für „max“ fehlt ein Text.
- Ein Codestand für Windows, macOS, Linux und iOS. Ein Android-Projekt gibt es nicht.

## Entwurf

### U1 — Stufe anlegen
- `ultra` in `ModelTier`, Schema und ENV (`ALFRED_LLM_ULTRA_PROVIDER/_MODEL/_API_KEY`), Router `TIERS`. Standard-Gründlichkeit `high` (Fable steuert über `output_config.effort`).
- Rückfall: Fehlt ultra oder fällt es aus, geht es auf `strong`, dann `default`. Bisher fällt jede fehlende Stufe direkt auf `default`. Jeder Rückfall von ultra wird gemeldet.
- Wächter: `ultra` gehört **nicht** zu `KERN_TIERS`, sein Ausfall ist kein Kernausfall. Die Probe-Liste bleibt generisch.
- Belegung live: `claude-fable-5-2` (Anthropic). Seit v1918 ist es mit Fallback-Header lauffähig.
- Alle hartkodierten Stufen-Listen nachziehen (Liste in der Bestandsaufnahme, z. B. API-Key-Suche in `alfred.ts`, CLI `/tier`, Setup).

### U2 — Auslöser (deterministisch)
1. **Ausdrücklich:** Der Owner wählt ultra in App, CLI oder per HTTP-`tier`. Die Stufe gilt nur für diese Nachricht.
2. **Gegenprüfung vor der Freigabe:** Wird ein Change mit Risiko `high` oder `critical` zur Freigabe gestellt (`freigabe_anfragen`), prüft ultra den gespeicherten Plan einmal. Es schreibt dabei nichts neu und liefert nur Befunde (fehlender Rückweg, falsche Reihenfolge, Prüfung passt nicht zur Aktion, Risiko unterschätzt). Die Befunde kommen in den Faden und an die Freigabeanfrage („von ultra gegengeprüft: N Befunde“). Gibt es Befunde, verlangt die Freigabeanfrage vom planenden Modell, sie zu beantworten (umgesetzt oder begründet abgelehnt). Das Muster ist dasselbe wie bei Einwänden. Feste Prüfungen im Code (FESTE_AUSGABEN, R45 usw.) laufen weiterhin zuerst. ultra ist für das, was sich nicht als Regel fassen lässt.
3. **Eskalation nach objektivem Fehlschlag:** Die nächste Antwort im selben Faden läuft auf ultra, wenn
   - die Planprüfung einen Planentwurf zweimal in Folge abgelehnt hat, oder
   - der Owner einen Einwand zu einem Change oder Vorhaben erhoben hat, oder
   - ein Change angehalten ist und eine Korrektur (Plan ab Haltepunkt) entworfen wird.

   Die Stufe gilt, bis der Entwurf gespeichert ist oder der Owner wieder eine andere Stufe wählt.
4. **Nie** aus einer Einschätzung des Modells heraus, nie für Hintergrundjobs, Zusammenfassungen oder Social.

### U3 — Sichtbarkeit und Kosten
- Jede Nutzung von ultra protokolliert den Auslöser (`ultra: ausdrücklich | gegenpruefung:<change> | eskalation:<grund>`) und die Kosten.
- Tagesbericht: Anzahl, Auslöser und Kosten von ultra. Das Tagesbudget gilt weiter gesamt.
- Im Faden steht bei einer Eskalation eine Zeile: „auf ultra gewechselt, weil: …“.

### U4 — Apps
- Auswahl: „Ultra“ als vierte Stufe neben Schnell, Normal und Stark. Sie gilt nur für die nächste Nachricht und springt danach auf „Automatisch“ zurück, damit sie nicht versehentlich teuer stehen bleibt.
- Anzeige je Antwort: „Modell · Gründlichkeit · Auslöser“, z. B. „claude-fable-5-2 · Gründlichkeit hoch · Gegenprüfung Change high“. `/api/geraete/stufen` liefert dafür zusätzlich `grund`. „max“ bekommt einen Text.
- Web-Oberfläche: dieselbe Auswahl, sofern dort eine Stufenwahl existiert.
- Ein Release für Windows, macOS, Linux und iOS über die bestehenden Release-Ketten.

## Beweise (Abnahme)
1. ENV gesetzt, Logzeile „LLM tier initialized … ultra … claude-fable-5-2“.
2. Ausdrücklich: Eine Nachricht mit `tier: ultra` wird von Fable beantwortet (Logzeile „LLM call completed“ mit Modell und Auslöser), die nächste wieder automatisch.
3. Gegenprüfung: Ein Test-Change mit Risiko high erhält vor der Freigabe Befunde von ultra (Faden und Log). Ein Change mit Risiko low bekommt keine.
4. Eskalation: Ein Owner-Einwand führt dazu, dass die nächste Antwort auf ultra läuft, mit Zeile im Faden.
5. Ausfall: Wird ultra absichtlich falsch konfiguriert (Testmodell), fällt es auf strong zurück, mit Meldung.
6. Apps: Auswahl und Anzeige auf Windows (Owner) und einer weiteren Plattform.

## Offene Owner-Entscheidungen
- O1: Soll die Gegenprüfung (U2.2) schon ab Risiko `medium` greifen? Empfehlung: nein, erst `high` und `critical`.
- O2: Gründlichkeit von ultra `high` oder `max`? Empfehlung: `high`. `max` nur bei ausdrücklicher Wahl.
