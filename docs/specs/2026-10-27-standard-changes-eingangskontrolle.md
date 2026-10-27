# Standard-Changes mit Eingangskontrolle

Stand 27.10.2026. Entwurf, nicht freigegeben. Auslöser ist die Kostenanalyse vom 27.10.: Das Planen der Infrastruktur-Changes per Modell kostete seit 22.10. rund 179 $. Wiederkehrende Arbeiten wie Updates und Restoretests dürfen nicht jedes Mal neu geplant werden. Gleichzeitig dürfen sie bei geänderten Bedingungen nicht blind laufen (Owner 27.10.: „wie kann man sicherstellen, dass es bei geänderten Bedingungen weiter funktioniert – das sollte besser und weitergedacht werden“).

## 1. Ausgangslage (belegt)

- **Es gibt schon Standard-Vorlagen** (`standard-vorlagen.ts`, I4b Teil 4). Ihre Pläne erzeugt Code (`erzeuge`), nicht das Modell. Der Owner gibt eine Vorlage einmal frei; die Freigabe ist an den Abdruck der Vorlage gebunden, und jede Änderung braucht eine neue Freigabe. Vorhanden sind:
  - (a) Snapshot anlegen und aufräumen
  - (c) Sicherheitsupdates
  - (d) Image derselben Hauptversion
  - (e) Neustart bei „unhealthy“
  - (b), (f), (g) folgen noch.
- **Die Vorlage (c) wurde für I9 nicht genutzt.** Alfred hat fünf Changes neu geplant. Das kostete mehrere Planungsrunden, darunter einen Unteragenten-Lauf mit Zeitüberschreitung. Gemessen an der Qualität der neuen Pläne ist (c) zu schwach:
  - Docker-Pakete werden nicht gesperrt.
  - Es gibt keinen Vorher-/Nachher-Vergleich der Container.
  - Neustart nur „bei Bedarf“ gibt es nicht, ebenso kein Nachtfenster-Gate.
  - Es gibt keine dienstspezifischen Prüfungen.
- **Der Restoretest** (`a3982e74`, 56 Schritte, alle bestanden) ist ein bewährter, rein schematischer Ablauf und damit ein guter Kandidat.
- **Ausführen kostet keine Modellaufrufe** (Motor). Kosten entstehen nur beim Planen.

## 2. Ziel

Wiederkehrende Changes entstehen ohne Modell aus geprüften Vorlagen. Bei jeder Nutzung wird geprüft, ob die Annahmen der Vorlage noch stimmen. Weicht etwas ab, läuft die Vorlage nicht. Der Fall geht dann in die normale Einzelplanung, und Alfred schlägt eine Anpassung der Vorlage vor.

## 3. Grundsätze

1. **Kein blindes Abspielen.** Eine Vorlage ist ein geprüftes Rezept mit Eingangskontrolle.
2. **Pläne erzeugt Code, nicht das Modell.** Das Modell wird nur gebraucht, wenn die Eingangskontrolle eine Abweichung meldet, oder um eine neue Vorlagen-Version vorzuschlagen.
3. **Der Ist-Stand liefert die Prüfungen.** Was nach dem Change laufen muss, erhebt der Lauf selbst vorher, nicht die Vorlage.
4. **Vorlagen entstehen nur aus bewährten Changes.** Grundlage ist mindestens ein erfolgreich abgeschlossener Einzel-Change.
5. **Ein Halt sperrt die Vorlage**, bis sie überprüft ist.
6. **Es gelten dieselben Schutzregeln wie für jeden Change:** Planprüfung, Fingerabdruck, Rückweg, Wartungsfenster, Sperrzeiten, Bericht.

## 4. Bausteine

### 4.1 Annahmen je Vorlage (deklarativ)

Jede Vorlage nennt ihre Annahmen als Liste. Jede Annahme hat eine Kennung, einen Text für den Owner, eine **lesende** Prüfung und eine Erwartung. Beispiele für „Updates v2“:

| Kennung | Annahme | Prüfung (lesend) |
|---|---|---|
| os | Ubuntu 22.04/24.04 oder Debian 12/13 | `/etc/os-release` |
| apt | apt und python3-apt vorhanden | `dpkg -s python3-apt` |
| docker-pakete | Docker-Pakete heißen docker-*/containerd*/runc | `dpkg -l` |
| snapshot | VM liegt auf einem snapshot-fähigen Speicher | Proxmox-Konfiguration |
| agent | Gast-Agent antwortet | `agent_status` |
| platz | genug Platz für den Snapshot | Speicherbelegung |
| keine-sperre | kein laufender oder angehaltener Change auf der VM | Motor |

Annahmen sind Teil des Vorlagen-Abdrucks. Wer sie ändert, braucht eine neue Freigabe.

### 4.2 Eingangskontrolle (zweimal)

1. **Beim Anlegen** des Changes aus der Vorlage. Fällt eine Annahme durch, wird kein Change angelegt; stattdessen kommt eine Meldung mit den Abweichungen (siehe 4.5).
2. **Als erster Schritt des Laufs.** Er prüft dieselben Annahmen noch einmal unmittelbar vor der Wirkung, denn zwischen Anlegen und Lauf können Stunden liegen. Dazu kommen das Zeitfenster-Gate (wie I9: Start nur im erlaubten Fenster, sonst Halt statt Hineinlaufen in die Sicherungen) und eine Platzprüfung (wie Restoretest).

Das Ergebnis ist eines von drei: *passt*, *Abweichung* (mit Liste) oder *unbekannt* (Prüfung nicht möglich). *Unbekannt* wird wie eine Abweichung behandelt.

### 4.3 Vorher-/Nachher-Erhebung (generisch)

Der Lauf erhebt vor der Wirkung den Ist-Stand und vergleicht ihn danach:
- laufende Container mit Image-ID, Restart-Policy und Healthcheck-Status;
- lauschende Ports;
- aktive systemd-Dienste;
- Kernel und Boot-ID.

Abnahme: dieselben Container laufen, keine Healthchecks sind von gesund auf ungesund gewechselt, dieselben Ports lauschen. Was **vorher** schon ungesund war (z. B. Noah), zählt nicht als Fehler, wird aber im Bericht genannt. So erkennt die Vorlage neue Dienste von selbst, ohne Änderung an der Vorlage.

### 4.4 Abnahme-Prüfungen aus der CMDB statt aus der Vorlage

Dienstspezifische Prüfungen gehören an das **Asset**, nicht in die Vorlage. Beispiele:
- Matrix: Synapse-Health, LiveKit-, JWT- und coturn-Ports lokal;
- Vaultwarden, Guacamole, Web: HTTP lokal.

Jedes Asset bekommt in der CMDB ein Prüfprofil: lesende Prüfungen aus der Leseliste mit Erwartung. Alle Vorlagen nutzen es: Updates, Restoretest (Prüfung der Kopie), Neustart, Image-Update. Auch Umzugs-Changes können es verwenden.
- **Pflege:** Alfred schlägt Prüfungen vor, wenn ein Dienst neu ist oder ein Umzug abgeschlossen wird. Der Owner bestätigt sie. Bei bestehenden Assets legt die Erst-Erhebung das Profil an.
- **Fehlt ein Profil,** gilt nur der generische Vergleich aus 4.3. Der Bericht sagt das ausdrücklich.

### 4.5 Wenn die Eingangskontrolle abweicht

- Der Change aus der Vorlage wird **nicht** angelegt bzw. hält in Schritt 1 an. Die Meldung nennt die Abweichungen in Klartext, z. B. „VM 149: neuer Container `matrix-hookshot` (nicht in der Vorher-Liste der Vorlage)“ oder „VM 147 jetzt auf Debian 13“.
- **Option 1:** Alfred plant den Einzelfall wie bisher (Modell). Er bekommt die Vorlage als Ausgangsplan und nur die Abweichungen dazu, nicht den ganzen Verlauf. Das hält die Planung kurz.
- **Option 2:** Alfred schlägt eine **neue Version der Vorlage** vor, als Unterschied zur alten mit Begründung. Der Owner gibt sie frei oder lehnt ab.
- Welche Option greift, entscheidet der Owner (offene Frage 7.3).

### 4.6 Version, Freigabe und Sperre

- **Vorhanden:** Version und Abdruck je Vorlage, Freigabe nur über die Owner-Frage, Widerruf.
- **Neu:**
  - Hält ein Lauf aus einer Vorlage an oder muss ein Rückweg laufen, wird die Vorlage auf „überprüfen“ gesetzt. Es entstehen keine weiteren Changes daraus, bis eine Prüfung oder neue Version freigegeben ist.
  - Je Vorlage gibt es einen Zähler für erfolgreiche Läufe und ein Datum des letzten Laufs; beides steht in der Vorlagen-Liste.
  - Eine Vorlage verfällt nach **n Monaten ohne Lauf** in den Zustand „überprüfen“, weil sich die Umgebung inzwischen geändert haben kann. Die Zahl n legt der Owner fest.

### 4.7 Trockenlauf

Wo möglich, enthält der Lauf vor der Wirkung eine Simulation, und der Change hält bei unerwartetem Ergebnis an:
- Updates: `apt-get -s` mit gesperrten Docker-Paketen; heute schon in I9.
- Image-Update: `pull` ohne `up`.
- Restore: Platzprüfung.

### 4.8 Herkunft: Vorlage aus bewährtem Change

- Alfred erkennt **Kandidaten**: Changes, die sich im Aufbau wiederholen (gleiche Skills, Aktionen und Schrittfolge über mehrere Assets) und erfolgreich abgeschlossen sind. Ein Beispiel sind die fünf I9-Changes nach dieser Nacht.
- Der Vorschlag nennt den Quell-Change, die Schrittfolge, die Parameter je Asset und die abgeleiteten Annahmen.
- Umgesetzt wird eine Vorlage als **Code** (`erzeuge` + Annahmen + Tests), nicht als gespeicherter Modell-Plan. Nur so ist sie deterministisch und testbar.

### 4.9 Serien

Ein Aufruf kann mehrere Assets betreffen, z. B. „Updates für alle Docker-VMs“:
- **Reihenfolge:** kritische Dienste zuletzt, z. B. Matrix, Tresor. Sie kommt aus der CMDB-Kritikalität, sonst gibt der Owner sie vor.
- **Verkettung:** über Abhängigkeiten.
- **Zeitfenster:** ein gemeinsames für alle; was nicht hineinpasst, wandert in die nächste Nacht.
- **Fehler:** Hält ein Glied an, laufen die folgenden nicht. Sie bleiben freigegeben und warten.

### 4.10 Bericht und Messung

- Der Bericht je Lauf enthält: Ergebnis der Eingangskontrolle, Vorher/Nachher-Vergleich, Prüfprofil-Ergebnis, Dauer und Ausfallzeit.
- Die Modellkosten je Vorlage werden gemessen (Ziel ≈ 0 $) und mit der Einzelplanung verglichen.

## 5. Erste Vorlagen (Vorschlag)

| Vorlage | Quelle | Ersetzt |
|---|---|---|
| Updates v2 (Version 2 von c) | I9-Changes 28.10. (nach Erfolg) | (c) v1 |
| Restoretest | `a3982e74` | — |
| Snapshot-Aufräumen nach Frist | vorhanden (a) | — |
| Aufräumen nach Umzug (Originale, Staging, Übergangsregeln) | Aufräum-Change ab 03.11. | — |

## 6. Was bewusst nicht gemacht wird

- Keine vom Modell gespeicherten Pläne als „Vorlage“; sie wären nicht testbar und würden still veralten.
- Kein automatisches Anpassen einer Vorlage ohne Owner-Freigabe.
- Keine Standard-Changes für Datenbanken oder Home Assistant: Die vorhandene Sperre `DB_ODER_HA` bleibt.

## 7. Offene Owner-Entscheidungen

1. **Freigabeart:** Darf Alfred aus einer freigegebenen Vorlage Changes **ohne Einzel-Ja** im Wartungsfenster anlegen (heutige Semantik der Standard-Changes)? Oder soll jeder Lauf eine kurze Freigabe-Frage bekommen (eine pro Serie)?
2. **Rhythmus:** Wann laufen Updates und Restoretests, z. B. Updates monatlich und Restoretest vierteljährlich? Und zu welcher Zeit?
3. **Bei Abweichung:** Einzelfall automatisch planen lassen, nur melden, oder beides?
4. **Verfall:** Nach wie vielen Monaten ohne Lauf soll eine Vorlage überprüft werden?
5. **Prüfprofile:** Soll Alfred sie für die bestehenden Assets jetzt vorschlagen (einmaliger Planungsaufwand) oder erst beim nächsten Change am jeweiligen Asset?

## 8. Umsetzung in Etappen (je Release mit Live-Beweis)

- **S1:** Annahmen und Eingangskontrolle im Vorlagen-Gerüst; Sperre nach Halt; Zähler. Beweis: (a) Snapshot mit absichtlich verletzter Annahme in einem Test-Change.
- **S2:** Generische Vorher-/Nachher-Erhebung als wiederverwendbarer Schritt. Beweis: Neustart-Vorlage (e) an einem unkritischen Container.
- **S3:** Prüfprofile in der CMDB, mit Vorschlag durch Alfred und Bestätigung durch den Owner.
- **S4:** Updates v2 aus den I9-Changes; Serie über die fünf Docker-VMs; Abweichungsfall mit Einzelplanung (Option 1).
- **S5:** Restoretest-Vorlage; Kandidaten-Erkennung (4.8).

## 9. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Annahmen unvollständig, die Vorlage läuft in einen unbekannten Zustand | Vorher-/Nachher-Vergleich; Halt sperrt die Vorlage; Rückweg über Snapshot |
| Zu viele Abweichungen, Vorlagen laufen selten | Annahmen eng, aber nicht pedantisch formulieren; Abweichungen im Bericht zählen und Vorlagen nachschärfen |
| Prüfprofile veralten | Pflege bei jedem Umzug oder neuen Dienst; Abweichung im Vorher-/Nachher-Vergleich zeigt neue Dienste |
| Owner verliert den Überblick über Läufe ohne Einzel-Ja | Ankündigung vor der Serie (Kalender), Bericht danach, Widerruf jederzeit |

## 10. Owner-Entscheidungen 27.10.2026

1. **Freigabe:** ein einzelnes Ja **je Serie** (vom Owner bestätigt): eine Freigabe-Frage pro Lauf über alle betroffenen Assets, je Asset mit den anstehenden Änderungen und dem Ergebnis der Eingangskontrolle; einzelne Assets per Einwand ausnehmbar; kein Lauf ohne Ja.
2. **Rhythmus:** Updates **wöchentlich**, Restoretests **vierteljährlich**, nachts ab 00:30.
3. **Bei Abweichung:** **beides**, also melden und den Einzelfall automatisch planen lassen (zur Freigabe).
4. **Verfall:** Eine Vorlage wird nach **mindestens 2 Monaten** ohne Lauf auf „überprüfen“ gesetzt.
5. **Prüfprofile:** vom Owner bestätigt: sofort für die fünf neuen Docker-VMs (144, 146, 147, 148, 149). Ihre Dienste und Prüfungen sind aus den Umzugs- und I9-Changes bekannt, und sie laufen wöchentlich. Alle anderen Assets bekommen ein Profil beim nächsten Change am jeweiligen Asset.
