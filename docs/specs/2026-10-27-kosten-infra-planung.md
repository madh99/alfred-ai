# Kosten der Infrastruktur-Planung senken, ohne Qualitätsverlust

Stand 27.10.2026. Zusammenhängender Vorschlag, **nicht freigegeben**. Nicht enthalten sind nach Owner-Entscheidung 27.10.:
- A: Fallback-Kette nach Kosten ordnen;
- E: Updates ohne Modell auslösen.

## 1. Messbefund (27.10.)

Quellen: `llm_usage`, Logzeilen `llm_request_prep` und `LLM call completed` sowie die Dashboards von OpenAI und Anthropic (Owner, 7 Tage).

- **Kosten:** seit 22.10. 179 $, davon 173 $ Chat; vorher ~6 $/Tag. Opus: 69 $, nur als Ersatz bei leerem OpenAI-Guthaben.
- **Kontext zu Beginn einer Nachricht im Infra-Faden, Ø 105k Token:**

  | Teil | Token | Anteil |
  |---|---|---|
  | Werkzeug-Beschreibungen (Ø 67 Werkzeuge) | 57k | 54 % |
  | Systemprompt | 29k | 27 % |
  | Verlauf | 19k | 18 % |

- **Innerhalb einer Nachricht:**
  - Ø 8,7 Modellaufrufe; Kontext 100k → 193k Token (höchstens 467k).
  - Folgerunden tragen 59 % der Kosten.
  - Ausreißer mit 44–76 Runden, meist Erhebungen mit vielen einzelnen Lesebefehlen.
- **Cache bei gpt-6.1-sol:**
  - In den Logs ist `inputTokens` der **gesamte** Input, gecachte Token eingeschlossen. Das bestätigt das OpenAI-Dashboard: 217,9 Mio. gesamt, 180,1 Mio. Cache-Lesen, 37,4 Mio. Cache-Schreiben, 0,36 Mio. ungecacht, 82,7 % Treffer.
  - **Erste Runde jeder Nachricht: 2 % aus dem Cache.** Praktisch jede Nachricht schreibt den ganzen Prefix neu; die 37,4 Mio. Cache-Schreiben stammen im Wesentlichen daher.
  - **Folgerunden: ~97 % aus dem Cache.** Das funktioniert.
  - Ursache für Runde 1: `computeCacheKey` (`packages/llm/src/providers/openai.ts`) hasht den ganzen Systemprompt samt seiner wechselnden Teile. Jede Nachricht bekommt dadurch einen neuen `prompt_cache_key`.
- **Cache bei Anthropic:** Opus 98,9 % Lesen, also gut innerhalb einer Nachricht. Haiku 39 %: Hintergrundjobs mit kurzen, wechselnden Prompts. Auch hier wird zu Beginn jeder Nachricht neu geschrieben (5-Minuten-Schreibvorgänge).
- **Unteragent `delegate`:**
  - 33 Läufe, höchstens ~46 $.
  - Meldet „erfolgreich“ auch bei Teilergebnis (I9: 2 von 5 Changes gespeichert).
  - Mehrere Aufträge dienten nur dazu, „vollständige Daten zu holen“, weil Werkzeug-Ausgaben gekürzt waren.
- **Standard-Vorlage „(c) Sicherheitsupdates“** existiert, wurde für I9 nicht genutzt und neu geplant (siehe Spec `2026-10-27-standard-changes-eingangskontrolle.md`).

Frühere Entscheidungen, die gelten bleiben:
- 0.10.52: statische Prompt-Teile vor dynamischen; Anthropic `cache_control`.
- v1355: `prompt_cache_key` je System und Werkzeugen.
- v1257: Werkzeug-Beschreibungen bleiben vollständig.
- fd381940: Skill-Liste im Prompt bleibt.

Keine Maßnahme unten verändert, *was* das Modell sieht. Ausnahme ist K3: Dort sieht es dieselben Daten in weniger Runden.

## 2. Maßnahmen

### K1 – Cache-Schlüssel über den stabilen Teil (kein Qualitätsrisiko)

- Bei OpenAI wird der `prompt_cache_key` nur noch aus dem **stabilen Anfang** gebildet: den Werkzeugen und den statischen Sektionen des Systemprompts. Die wechselnden Sektionen fließen nicht mehr ein. Was gesendet wird, bleibt gleich.
- Bei Anthropic wird der Systemprompt in zwei Blöcke geteilt: einen statischen mit `cache_control`, danach einen dynamischen ohne. Heute liegt der Marker hinter dem ganzen Systemprompt; jede Änderung in den dynamischen Teilen macht deshalb den ganzen Block neu.
- **Voraussetzung:** Die Werkzeugliste muss innerhalb eines Fadens stabil sein. Heute schwankt sie zwischen 86 und 91 Werkzeugen, je nach Skill-Filter. K1 misst zuerst, wie oft sich die Liste ändert. Ändert sie sich bei fast jeder Nachricht, nützt der stabile Schlüssel wenig; dann folgt K1b.
- **K1b (nur falls nötig):** Die Werkzeugliste eines Fadens wird nur noch *erweitert*, nie umsortiert. Neue Werkzeuge kommen ans Ende; der Skill-Filter bleibt sonst unverändert.
- **Messung vorher und nachher:** Cache-Anteil der ersten Runde, Werte aus dem OpenAI-Dashboard, Kosten je Nachricht im Infra-Faden. Ziel: Die erste Runde liest den stabilen Teil aus dem Cache, wenn die vorige Nachricht weniger als ~30 Minuten (OpenAI) bzw. 5 Minuten (Anthropic) zurückliegt.
- **Geschätzte Wirkung:** Die erste Runde macht bei gpt im Faden ~53 % der Kosten aus. Liest sie 80 % des Prefix aus dem Cache, sinkt dieser Teil deutlich. Wie viel genau, zeigt erst die Messung.

### K2 – Cache-Diagnose je Anfrage mitschicken (Code, nur Messung)

Korrektur 27.10.: In den Dashboards lässt sich nichts aktivieren. Bei beiden Anbietern wird die Diagnose **je Anfrage** angefordert:
- **Anthropic:** `diagnostics: { previous_message_id: <id der vorigen Antwort> }`, beim ersten Zug `null`. Die Antwort enthält `diagnostics.cache_miss_reason.type`, zum Beispiel `system_changed`, `tools_changed`, `messages_changed`, `model_changed`, und dazu `cache_missed_input_tokens`. Beim Streaming steht das im `message_start`-Event.
- **OpenAI (Responses, GPT-5.6 und neuer):** `prompt_cache_options: { comparison_response_id: <id> }`. Die Antwort enthält `prompt_cache_diagnostics` mit `type` (`cache_hit`/`cache_miss`/…) und `reason`, zum Beispiel `prompt_cache_key_changed`, `tools_changed`, `input_changed`, `model_changed`, dazu `cache_missed_tokens`. Beim Streaming steht es im Event `response.completed`.

Beide sind ohne Zusatzkosten, ändern weder Caching noch Ausgabe, speichern keine Prompt-Inhalte (ZDR-fähig) und blockieren nie eine Anfrage.

Umsetzung: Alfred merkt sich je Gespräch die letzte Antwort-ID je Anbieter und Modell, schickt den Parameter mit und protokolliert den Grund samt verlorener Token. Ein Bericht zeigt dann für den Infra-Faden, *warum* die erste Runde nicht trifft. Erwartet wird `prompt_cache_key_changed` bei OpenAI und `system_changed` bei Anthropic; belegt ist das noch nicht. K2 ändert nichts am Verhalten. Es ist reine Messung und Voraussetzung, um K1 gezielt umzusetzen.

### K3 – Lesebündel: weniger Werkzeugrunden (Qualität gleich)

- `fernzugriff.lesen` (und die Prüfungen der Leseliste) nehmen optional **mehrere Befehle** in einem Aufruf an. Sie laufen nacheinander im selben Lese-Käfig, und jede Ausgabe kommt mit Überschrift zurück. Dabei bleiben eine Obergrenze je Aufruf für Anzahl und Ausgabelänge und die Regeln der Leseliste je Befehl.
- In der Skill-Anleitung steht dann: Erhebungen bündeln, statt Befehl für Befehl zu fragen.
- **Wirkung:** Erhebungen mit 40–70 Runden schrumpfen auf wenige. Jede eingesparte Runde spart den wachsenden Kontext (100k–460k Token).
- **Risiko:** Längere Einzelausgaben. Gegenmaßnahme sind die Obergrenze und eine Kürzung je Befehl mit Hinweis.

### K4 – Vollständige Daten ohne Umweg

- `change_zeigen` bekommt die Möglichkeit, **einzelne Schritte vollständig** auszugeben (`schritte: [8, 19]`). Heute sieht das Modell große Pläne nur gekürzt und weicht auf Unteragenten oder Rückfragen aus.
- Dasselbe gilt für Architektur-Fassungen: abschnittsweise statt am Stück.
- **Wirkung:** Die Unteragenten-Umwege und die Rückfrage „bitte vollständige Schrittobjekte bereitstellen“ (Realfall 27.10.) entfallen.

### K5 – Unteragent nur für Lese-Erhebungen, mit nachprüfbarem Ergebnis

1. **Regel in der Skill-Anleitung:** Lese-Erhebungen mit viel Rohausgabe dürfen an `delegate` gehen. Changes planen, speichern und Freigaben anfragen bleibt beim Hauptgespräch, das den Faden kennt.
2. **Ehrlicher Status:** Läuft ein Unteragent in sein Zeitbudget, meldet er „teilweise“ mit dem erreichten Stand, nicht „erfolgreich“.
3. **Strukturierte Rückgabe** für Erhebungen, z. B. je Host: Befehl → Ergebnis kurz, Auffälligkeiten.
4. **Nachprüfen:** Hat ein Auftrag etwas gespeichert, prüft Alfred das Ergebnis selbst nach (z. B. Anzahl der Changes in der DB), statt der Zusammenfassung zu glauben.

Wirkung: weniger doppelte Grundkontexte und keine stillen Halbergebnisse. Die Qualität steigt.

### K6 – Standard-Changes mit Eingangskontrolle

Siehe eigene Spec, Etappen S1–S5. Wirkung: Wiederkehrende Wartung kostet fast keine Modellaufrufe mehr.

## 3. Reihenfolge und Messpunkte

| Schritt | Inhalt | Messpunkt / Beweis |
|---|---|---|
| 0 | Basis messen (heute erledigt) | Werte oben |
| 0b | K2 Cache-Diagnose je Anfrage protokollieren | Grund je Fehlschlag (erste Runde) im Infra-Faden |
| 1 | K1: Messung der Werkzeuglisten-Stabilität, dann stabiler Cache-Schlüssel und geteilter Anthropic-Systemblock | Cache-Anteil der ersten Runde im Infra-Faden; Dashboard OpenAI/Anthropic eine Woche später |
| 2 | K3 Lesebündel | Runden je Erhebung (vorher 44–76) |
| 3 | K4 vollständige Teilausgaben | keine „vollständige Daten holen“-Delegationen mehr |
| 4 | K5 Delegations-Regeln und ehrlicher Status | Anteil „teilweise“ sichtbar, keine stillen Halbergebnisse |
| 5 | K6 / S1–S5 | Modellkosten je Wartungslauf ≈ 0 |

Jeder Schritt wird ein eigener Release mit Live-Messung. Erst wenn die Messung den erwarteten Effekt zeigt, folgt der nächste.

## 4. Bewusst nicht vorgeschlagen

- **Verlauf kürzen oder zusammenfassen:** nur 18 % des Kontexts, mit Qualitätsrisiko.
- **Werkzeug-Beschreibungen kürzen oder weglassen:** v1257 und fd381940. Nach K1 sind sie zudem größtenteils gecacht.
- **Fallback-Kette ändern (A)** und **Updates ohne Modell (E):** Owner 27.10.
