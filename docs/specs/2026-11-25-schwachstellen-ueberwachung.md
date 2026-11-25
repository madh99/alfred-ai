# Schwachstellen-Überwachung (CVE) mit Anzeige in Web und Apps

Stand 25.11.2026. Entwurf, nicht freigegeben.

**Anlass (Owner 25.11.):** Eine Mail zu Vaultwarden-CVEs blieb ohne Reaktion von Alfred. Der Owner fragt: „sollte man nicht nach aktueller Lage CVEs täglich prüfen? – und kann man das auch im Web und den Apps entsprechend mit Scores usw. Details visualisieren?“

## 1. Ausgangslage (belegt 25.11.)

- **Mails:** Alfred reagiert nur über Mail-Aufgaben mit fester Regel (Absender, Betreff). Davon gibt es genau eine (aWATTar). Sicherheitsmails sieht Alfred nicht.
- **Anwendungs-Update-Bericht** (v1707, montags 09:00):
  - Er vergleicht nur Versionen, native Pakete mit dem Kennzeichen `-security`, Container-Images gegen die Registry.
  - Seit 09.11. meldete er wöchentlich `docker-vault-01 / vaultwarden 1.30.5 → 1.37.5`. Er hatte aber keine Schwachstellen-Quelle, keinen Schweregrad und hat weder Befund noch Vorgang angelegt.
- **Folge:** Vaultwarden 1.30.5 ist von mehreren Advisories betroffen, darunter:
  - CVE-2026-43912, CVSS 8.7, behoben in 1.35.5;
  - eine Lücke beim Entziehen von Organisationsmitgliedern, CVSS 8.1, behoben in 1.37.4.
- **Vorhanden und nutzbar:**
  - Bestand je Host: Container mit Image, Tag und Digest, Version-Label; apt-Pakete.
  - Befunde, Problems und Vorgänge; Changes mit Prüfprofilen (S3).
  - Web-Seiten `befunde`, `cmdb`, `wartung`; App-Ansichten `befunde.dart`, `changes_ansicht.dart`.

## 2. Ziel

Täglich wissen, welche **laufende** Software (Container-Anwendungen, Basis-Images, native Pakete, Windows/SQL Server) von bekannten Schwachstellen betroffen ist, wie schwer und wie dringlich das ist und was dagegen getan wird. Sichtbar in Web und Apps, mit Scores und Details. Ab einem festen Schweregrad entsteht von selbst ein Vorgang mit vorgeschlagenem Change.

## 3. Bausteine

### 3.1 Umfang: die gesamte Infrastruktur (Owner 25.11.)

Geprüft wird **alles, was in der CMDB als aktiv steht**, nicht nur Vaultwarden. Jede Klasse hat eine eigene Versionsquelle und eine eigene Schwachstellen-Quelle:

| Klasse | Beispiele (Bestand 25.11.) | Version aus | Schwachstellen aus |
|---|---|---|---|
| Container-Anwendungen | 40 Container: Vaultwarden, Synapse, coturn, LiveKit, Guacamole, Open-WebUI, Dashy, NPM, WordPress … | Bestand (Image, Tag, Label) | OSV (GHSA, crates.io, PyPI, npm, Go, Maven) über die Zuordnung |
| Basis-Images der Container | Alpine/Debian-Pakete in den Images | Trivy (Etappe E) | Trivy-Datenbank |
| Linux-Server und -VMs, LXC | 28 Fernzugänge, Ubuntu/Debian, sqllnx01/02 | Bestand (apt) | OSV Debian/Ubuntu (USN/DSA) |
| Proxmox VE / PBS | pve, pve1, pve3, pve2 (PBS 4.2.8) | `pveversion`/apt über Proxmox | OSV Debian + Proxmox-Advisories (NVD CPE) |
| Datenbanken | PostgreSQL .91, MariaDB, Redis, MinIO, SQL Server Windows/Linux | Bestand bzw. `sql_server`/`linux_sql status` (Build, CU) | OSV bzw. MSRC (SQL Server) |
| Windows | DCs, SQL01/02, fs01, PKI, Admin-Clients | Build und installierte Updates (`windows_ad`/Fernzugang) | MSRC CVRF-API (je Build/KB) |
| Netzwerk | UniFi Dream Machine Pro, Switches, APs, UNAS; pfSense; MikroTik RouterOS | `unifi`/`pfsense`/`mikrotik` (Firmware/Version) | NVD (CPE-Abgleich) und Hersteller-Advisories |
| Home Assistant | Core, Add-ons, Zigbee2MQTT, Mosquitto | `homeassistant` (Version) | OSV (PyPI `homeassistant`) und GHSA |
| Alfred selbst | npm-Abhängigkeiten, Flutter-Apps | package-lock / pubspec.lock | OSV (npm, Pub) |

Was keiner Quelle zugeordnet werden kann, steht als „nicht geprüft“ mit Grund in Ansicht und Bericht. Nichts fällt still heraus.

### 3.1a Inventar → Komponenten (ohne Modell)

Jede laufende Komponente wird eine Zeile „was läuft wo in welcher Version“:

- **Container-Anwendung:** Image und Version (Tag, OCI-Label `org.opencontainers.image.version`, sonst `--version` aus einer festen Liste) → Paket in einem Ökosystem. Die Zuordnungstabelle steht im Code und ist erweiterbar, z. B.:
  - `vaultwarden/server` → crates.io `vaultwarden`;
  - `matrixdotorg/synapse` → PyPI `matrix-synapse`;
  - `guacamole/guacamole` → Maven `org.apache.guacamole`.

  Unbekannte Images stehen als „ohne Zuordnung“ in der Ansicht. Sie werden nie still übergangen.
- **Native Pakete** (Debian/Ubuntu): Name und installierte Version aus dem Bestand.
- **Windows / SQL Server:** Build und CU aus `sql_server status` bzw. `windows_ad`/Update-Stand. Das folgt als eigene Etappe.

### 3.2 Quellen (täglich)

| Quelle | wofür | Kosten |
|---|---|---|
| **OSV.dev** (API, ohne Konto) | Advisories je Paket und Version: GHSA, crates.io, PyPI, npm, Go, Maven, Debian, Ubuntu | frei |
| **CVSS** aus OSV/NVD | Schweregrad (v3.1/v4) | frei |
| **EPSS** (FIRST.org) | Wahrscheinlichkeit einer Ausnutzung in 30 Tagen | frei |
| **CISA KEV** | wird nachweislich ausgenutzt | frei |
| optional **Trivy** (Etappe C) | vollständiger Scan der Images inkl. Basis-Image-Pakete | Datenbank-Download ~täglich, Rechenzeit |

Abrufe laufen von Alfred aus mit normaler TLS-Prüfung. Gespeichert werden nur Metadaten: ID, Aliase, Scores, betroffene und behobene Versionen, Link.

### 3.3 Bewertung und Fristen

Dringlichkeit je Treffer, ohne Modell:

| Stufe | Bedingung | Frist (Vorschlag) |
|---|---|---|
| **kritisch** | KEV oder CVSS ≥ 9, oder CVSS ≥ 7 und von außen erreichbar (Proxy/Port-Forward in der CMDB) | 48 h |
| **hoch** | CVSS ≥ 7 oder EPSS ≥ 10 % | 7 Tage |
| **mittel** | CVSS ≥ 4 | 30 Tage |
| **niedrig** | Rest | im Wochenbericht |

„Von außen erreichbar“ kommt aus der CMDB: NPM-Proxy-Host oder UniFi-Port-Forward auf diesen Container. Vaultwarden ist z. B. über NPM veröffentlicht.

### 3.4 Was daraus entsteht

- Ab **hoch**: **Befund** je Komponente (nicht je CVE) mit allen offenen CVEs, höchstem Score, Frist und behobener Version.
- Daraus ein **Vorgang** mit Vorschlag: „Change: <Image> auf <behobene Version>“.
  - Für zustandslose Images über Vorlage (d), sofern die Hauptversion gleich bleibt.
  - Sonst als einzeln geplanter Change mit Sicherung, Snapshot-Rückweg und Abnahme durch das Prüfprofil (S3).
- Gelöst wird der Befund nur durch eine Belegung: Der nächste Lauf sieht die neue Version.
- **Akzeptieren** (Owner) mit Grund und Ablaufdatum ist möglich, z. B. „nur intern erreichbar, bis 31.12.“. Nach Ablauf meldet sich der Befund wieder.
- Neue **kritische** Treffer gehen sofort als Meldung an den Owner (Telegram/App-Push), nicht erst mit dem Wochenbericht.

### 3.5 Mail-Eingang für Sicherheitsmeldungen (Ergänzung)

Eine Mail-Aufgabe je Absender, den der Owner nennt, z. B. GitHub Security Advisories oder Hersteller-Newsletter. Sie löst sofort einen Lauf von 3.2 für die genannten Pakete aus und verknüpft die Mail mit dem Befund. Die Mail selbst ist kein Beleg; maßgeblich bleibt der Abgleich mit der laufenden Version.

### 3.6 Anzeige: Web und Apps

- **API:** `GET /api/schwachstellen` (Übersicht), `GET /api/schwachstellen/:komponente` (Detail), `POST …/akzeptieren`, `POST …/change-vorschlagen`.
- **Web-Seite „Sicherheit“** (neben Befunde/Wartung):
  - Kopf mit Kennzahlen: offen je Stufe, älteste überfällige Frist, Anteil der Komponenten ohne Zuordnung, letzter Lauf.
  - Tabelle je Komponente: Host, Anwendung, laufende → behobene Version, Anzahl CVEs, höchster CVSS (Farbbalken), EPSS, KEV-Marke, „von außen erreichbar“, Frist, Status (offen / Change geplant / Change läuft / behoben / akzeptiert bis …). Filter und Sortierung nach Score, Frist und Host.
  - Detail: jede CVE mit ID und Aliasen, CVSS-Vektor aufgeschlüsselt, EPSS mit Perzentil, KEV-Datum, betroffene und behobene Versionen, Kurzbeschreibung, Links (GHSA/NVD/Hersteller), verknüpfter Change und Mail, Verlauf (erkannt am, Frist, behoben am).
  - Verlauf als Diagramm: offene Treffer je Stufe über 90 Tage; mittlere Zeit bis zur Behebung.
- **Apps** (Desktop, Handy):
  - Kachel „Sicherheit“ mit Ampel und Anzahl kritisch/hoch.
  - Liste und Detail wie im Web, kompakt.
  - Push nur bei neuem **kritisch**.
  - Aktionen „Change vorschlagen“ und „akzeptieren“ laufen mit Bestätigung über den bestehenden Freigabe-Weg.

### 3.7 Speicherung

- Tabelle `sicherheit_komponenten`: Host, Asset, Art, Name, Version, Ökosystem und Paket, Zuordnung ja/nein, zuletzt gesehen.
- Tabelle `sicherheit_treffer`: Komponente, Advisory-ID, Aliase, CVSS mit Vektor, EPSS, KEV, betroffene und behobene Versionen, Stufe, Frist, Status, erkannt, behoben, akzeptiert bis mit Grund.
- Befunde und Vorgänge wie bisher, mit Verweis auf die Komponente.

## 4. Etappen (je Release mit Live-Beweis)

- **A:** Komponenten aus dem Bestand: Container, native Pakete aller Linux-Hosts, Proxmox/PBS, Datenbanken. Dazu OSV + CVSS + EPSS + KEV, Bewertung, täglicher Job, Befund/Vorgang ab hoch, Meldung bei kritisch, Abschnitt im Wochenbericht.
  - Beweis: Vaultwarden 1.30.5 erscheint mit den bekannten CVEs. Nach dem Update auf 1.37.5 ist der Befund gelöst.
  - Dazu: Synapse und die übrigen Images mit Zuordnung.
- **B:** API und Web-Seite „Sicherheit“ mit Detail und Verlauf; Akzeptieren mit Ablauf.
- **C:** Apps (Kachel, Liste, Detail, Push).
- **D:** Windows und SQL Server (MSRC), Netzwerkgeräte (UniFi, pfSense, MikroTik über NVD-CPE), Home Assistant, Alfred selbst (npm/Pub); Mail-Eingang für Sicherheitsmeldungen (3.5).
- **E (optional):** Trivy-Scan der Images für Basis-Image-Pakete.

## 5. Offene Owner-Entscheidungen

1. **Takt:** täglich um 06:00? Zusätzlich sofort nach jeder Bestandsaufnahme?
2. **Fristen und Stufen** wie in 3.3?
3. **Automatik:** Ab „hoch“ nur Befund und Vorgang mit Vorschlag (Change braucht wie immer dein Ja), oder soll Alfred den Change auch gleich planen und zur Freigabe vorlegen?
4. **Trivy** (Etappe E): ja/nein. Es ist vollständiger, aber schwerer (Datenbank und Rechenzeit).
5. **Mail-Absender** für 3.5: Wer hat die Vaultwarden-Mail geschickt?
6. **Push** in den Apps nur bei kritisch, oder auch bei hoch?

## 6. Was bewusst nicht gemacht wird

- Kein automatisches Einspielen von Updates ohne Change und Freigabe.
- Keine Bewertung durch das Modell. Scores kommen aus den Quellen, Stufen aus festen Regeln.
- Keine stille Lücke: Komponenten ohne Zuordnung oder mit nicht erreichbarer Quelle stehen sichtbar als „nicht geprüft“ in der Ansicht und im Bericht.
