# Schwachstellen-Überwachung (CVE) mit Anzeige in Web und Apps

Stand 25.11.2026. Entwurf; Entscheidungen 1, 2, 4, 5, 6 vom Owner getroffen (§5), 3 offen.

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

### 3.8 Neues kommt von selbst dazu (Owner 25.11.)

Die Prüfung geht nicht von einer festen Liste aus, sondern vom Bestand:

- **Neuer Container auf einer bestehenden VM:** Die tägliche CMDB-Discovery (heute 08:19) erfasst ihn. Die CVE-Prüfung läuft direkt danach und nimmt ihn mit. Trivy scannt das Image auch ohne bekannte Zuordnung, einschließlich der Basis-Image-Pakete.
- **Neues natives Paket:** kommt über die apt-Liste des Bestands.
- **Software außerhalb der Paketverwaltung** (Binaries unter /opt, /usr/local): Trivy-Dateisystem-Scan des Hosts (`trivy rootfs`, nur lesend), sonst bliebe eine Lücke.
- **Neue VM oder LXC:** Proxmox-Discovery. Mit Fernzugang wird sie vollständig geprüft. Ohne Fernzugang steht sie als „nicht geprüft: kein Fernzugang“ mit Befund in der Ansicht.
- **Neuer Dienst:** Alfred schlägt ein Prüfprofil vor (Spec Standard-Changes S3 §4.4), damit ein späteres Update abgenommen werden kann.

## 4. Etappen (je Release mit Live-Beweis)

- **A:** Komponenten aus dem Bestand: Container, native Pakete aller Linux-Hosts, Proxmox/PBS, Datenbanken. Dazu OSV + CVSS + EPSS + KEV, Bewertung, täglicher Job, Befund/Vorgang ab hoch, Meldung bei kritisch, Abschnitt im Wochenbericht.
  - Beweis: Vaultwarden 1.30.5 erscheint mit den bekannten CVEs. Nach dem Update auf 1.37.5 ist der Befund gelöst.
  - Dazu: Synapse und die übrigen Images mit Zuordnung.
- **B:** API und Web-Seite „Sicherheit“ mit Detail und Verlauf; Akzeptieren mit Ablauf.
- **C:** Apps (Kachel, Liste, Detail, Push).
- **D:** Windows und SQL Server (MSRC), Netzwerkgeräte (UniFi, pfSense, MikroTik über NVD-CPE), Home Assistant, Alfred selbst (npm/Pub); Mail-Eingang für Sicherheitsmeldungen (3.5).
- **E (optional):** Trivy-Scan der Images für Basis-Image-Pakete.

## 5. Owner-Entscheidungen 25.11.2026

1. **Takt:** täglich um 06:00. Zusätzlich läuft die Prüfung direkt nach jeder CMDB-Discovery, damit Neues nicht bis zu einem Tag wartet (Empfehlung, siehe 3.8).
2. **Fristen und Stufen:** wie in 3.3 (bestätigt).
3. **Automatik:** entschieden wie empfohlen (Owner 25.11.); Reihenfolge am 26.11. bestätigt: zuerst die kritischen Komponenten, die übrigen nach Frist. Ab „hoch“ plant Alfred den Change und legt ihn zur Freigabe vor; ohne Ja läuft nichts. Wo eine Vorlage passt, plant Code ohne Modell. Einzeln geplant werden nur Anwendungen mit Daten. Je Komponente gibt es höchstens einen offenen Change, neue CVEs fließen in den bestehenden ein.
4. **Trivy:** ja, für Images und als Dateisystem-Scan der Hosts.
5. **Mail-Absender:** `no-reply@bitwarden.com` (Hersteller Bitwarden). Die Mail löst einen sofortigen Abgleich für Vaultwarden und die Bitwarden-Clients aus.
6. **Push in den Apps:** nur bei „kritisch“.

## 6. Was bewusst nicht gemacht wird

- Kein automatisches Einspielen von Updates ohne Change und Freigabe.
- Keine Bewertung durch das Modell. Scores kommen aus den Quellen, Stufen aus festen Regeln.
- Keine stille Lücke: Komponenten ohne Zuordnung oder mit nicht erreichbarer Quelle stehen sichtbar als „nicht geprüft“ in der Ansicht und im Bericht.

## 7. Umsetzungsstand

- **A1** (v1959, 25.11.2026) — Erkennung:
  - **Quellen je Anwendung:** GitHub-Repo-Advisories des Herstellers, NVD per CPE (ohne Schlüssel höchstens 5 Abfragen je 30 s) und OSV, zusammengeführt über CVE/GHSA.
    - Realfall Vaultwarden 1.30.5: OSV allein lieferte 7 Advisories, NVD 16, die Repo-Advisories 37. Ohne die Repo-Advisories fehlte u. a. GHSA-69q9 (8.1). Deshalb gibt es alle drei Quellen.
    - Freie Bereichsangaben werden über die behobene Version ausgewertet (`versionen.ts`).
  - **Trivy 0.76.2** (Digest gepinnt) läuft als Container auf dem Alfred-Server, mit Cache-Volume `alfred-trivy-cache`, und scannt je Image den laufenden Digest. Lokal gebaute bzw. per eigener Registry übertragene Images stehen als „nicht geprüft“.
  - **Linux-Hosts inkl. Proxmox:** ausstehende Sicherheitsupdates (apt, Kennzeichen `-security`), angereichert über OSV (Debian/Ubuntu).
  - **EPSS und KEV**, Stufe je Treffer nach §3.3, Fristen ab dem ersten Erkennen.
  - **Speicherung:** Tabellen `sicherheit_komponenten`/`sicherheit_treffer` (PG v166, SQLite v162). Fail-closed: Behoben ist ein Treffer nur, wenn eine seiner Quellen im Lauf erfolgreich lief. Verschwundene Komponenten werden nur auf vollständig gelesenen Hosts aufgeräumt.
  - **Befunde** (Kategorie `sicherheit`, Schlüssel `sicherheit:<host>:<name>`) ab hoch: kritisch immer, hoch nur mit behobener Version. Kein anderer Abgleich legt sie an oder löst sie.
  - **Meldung und Push** nur bei neuem „kritisch“; Tagesdokument „Schwachstellen <Datum>“ in der CMDB.
  - **Job `schwachstellen`:** täglich 06:00, zusätzlich nach jeder CMDB-Discovery. Dazu `infrastruktur schwachstellen` (Lage) und `schwachstellen_pruefen` (sofort).
- **Kalibrierung** (v1960–v1962, 25./26.11.2026, Owner „wie empfohlen“). Der erste Lauf meldete 2.001 „kritisch“, 99 % davon Basis-Pakete alter Images.
  - **Basis-Pakete (Trivy):** kritisch nur bei KEV oder bei EPSS ≥ 10 % und Erreichbarkeit von außen. Hoch gilt bei EPSS ≥ 10 % oder bei CVSS ≥ 9 mit Fix. Anwendungen behalten §3.3.
  - **Zählung** je CVE und Komponente. **Ein Sammel-Befund je Image** mit der Maßnahme „Image aktualisieren bzw. neu bauen“.
  - **Meldung** nur für neu kritische Treffer, gebündelt je Komponente. Offene Problems übernehmen den aktuellen Befundtext (v1961).
  - **Quellen:** Fällt eine Quelle aus, schließt der Lauf keinen Treffer (fail-closed).
  - **Log (v1962):** Entfernte Komponenten stehen namentlich in der Logzeile, ihre Treffer zählen unter „behoben“.
  - **Stand Lauf 26.11. 06:00:** 103 kritisch, 693 hoch, 32 Befunde.
  - **Vaultwarden-Beweis (Change 31d548a4, 26.11. 00:35):** 9.798 Treffer behoben, die Anwendungs-CVEs sind weg. Das Basis-Image zeigt weiter CVE-2011-3389 (BEAST) in libgnutls ohne Fix (EPSS 73 %), Entscheidung siehe Offen.
- **Basis ohne Fix** (v1963, Owner 26.11.): Ein kritischer Basis-Treffer ohne behobene Version und ohne KEV ist kein Handlungsbedarf (`handlungsbedarf()`): kein Befund, keine Meldung, sichtbar in Ansicht und Bericht. Beweis Lauf 26.11. 09:41: Vaultwarden 1.37.5 nicht mehr KRITISCH, es bleibt „hoch“ für libmariadb3 mit Fix.
- **A2** (v1964, Owner 26.11. „wie empfohlen“): Die Vorlage (d) passt bei keinem der 32 Images so, dass sie etwas behebt. Gründe: `latest`/`main`/`stable`, Digest statt Tag, kein Healthcheck, Datenbank. Daher:
  - **Auswahl ohne Modell** (`schwachstellen/planung.ts`): Container mit Handlungsbedarf, kritische zuerst (KEV und erreichbar, KEV, erreichbar, Anzahl). Hohe kommen erst, wenn kein kritischer Kandidat mehr offen ist.
  - **Kein zweiter Plan**, solange ein offener Change (auch ein Entwurf) dasselbe Asset betrifft. Das gilt auch, wenn ein verknüpfter Change abgelehnt wurde, gescheitert ist oder zurückgerollt wurde. Erst nach `completed` mit bleibendem Befund wird neu geplant.
  - **Planung:** Je Kandidat läuft eine Modell-Runde im sichtbaren Faden `owner:faden:infra-cf82f3f2` mit festem Auftrag: genau ein Change mit Sicherung, Rückweg und Prüfprofil, dann `freigabe_anfragen`, nichts ausführen.
    - Die Runden laufen nacheinander, je Komponente höchstens ein Versuch am Tag (`claimDailySlot`).
    - Der neue Change wird mit dem Problem verknüpft. Fehlt der Faden, wird nichts geplant.
  - **Unbeaufsichtigt** (`SkillContext.unbeaufsichtigt`, nur vom Code gesetzt):
    - Skills nur `infrastruktur` und `fernzugriff`.
    - Erlaubt sind nur `changes_planen`, `freigabe_anfragen`, `pruefprofil_vorschlagen` sowie lesende Aktionen (Fernzugriff: `liste`, `lesen`, `pruefen`, `seite`).
    - Alles andere ist gesperrt, ebenso eine neue Prüfung.
- **Härtung A2** (v1965, v1967):
  - Die Skill-Sperre gilt auch beim Ausführen eines Werkzeugs (`executeToolCall`), nicht nur in der angebotenen Liste; Grundregel: verweigern.
  - Fernzugriff zusätzlich `datenbank_inventar` lesend.
  - Quelltexte stehen nur bereinigt im Datenblock `<<<DATEN … DATEN>>>`. Fehler der Zielprüfung erscheinen nur als feste Ursache (`fehlerArt`).
  - `reasoning_slots` sind dauerhaft je Schlüssel, nicht je Tag. Der Schlüssel ist daher Komponente + Befund + Zielprüfung: Ein neuer Versuch entsteht nur, wenn sich etwas ändert. Ohne Antwort oder bei Fehler wird die Sperre freigegeben.
- **Zielprüfung** (v1966): Vor der Runde scannt der Code das Ziel-Image mit Trivy. Ziel ist derselbe Tag im aktuellen Stand oder der Tag der behobenen Anwendungsversion.
  - Der Auftrag nennt Digest sowie behobene und bleibende Treffer. Behebt das Ziel nichts, gibt es keine Runde (`ohneWirkung`).
  - Als Digest gilt nur ein RepoDigest desselben Repositorys (v1967).
- **Titelmarke** (v1968): Der Changetitel beginnt mit `A2 <Problem-ID> – `. Die Verknüpfung läuft zuerst über die Marke (genau ein Treffer), dann über Asset oder Namen.
  - Vor der Planung werden Changes mit Marke nachverknüpft.
  - Ein offener Change mit Marke verhindert einen zweiten Plan.
- **v1969:**
  - Bei festem Versions-Tag und behobener Anwendungsversion scannt die Zielprüfung zuerst den Tag dieser Version, dann denselben Tag (EMHASS v0.18.0 → v0.19.0).
  - Ein neuer Prüfprofil-Vorschlag zieht überholte oder abgelaufene Profilfragen zurück. Am 26.11. standen 15 Bestätigungen offen: 7 Change-Freigaben und 8 Profilfragen, davon 5 überholt.
  - Der Change-Motor startet im selben Durchgang keine zwei Changes auf demselben Asset. Am 26.11. starteten ffdfb929 und 347d2aea gleichzeitig auf VM 144.
- **Erste Freigabe-Serie 26.11. (18:55):**
  - Abgeschlossen: Ombi b111b3a2, pgAdmin ffdfb929, Glances 085dc9a4.
  - Zurückgerollt: nginx e51b4dcb. Die eigene Schutzprüfung schlug an (`NGINX_HOST_OPTIONS_DRIFT`).
  - postgreDEV 347d2aea wartet bei Owner-Schritt 4 (Schreibpause). WordPress df90a112 und MySQL 9123859a warten auf das Asset.
- **Erste Serie 26.11. (v1967), 18 Kandidaten:**
  - 10 Changes, davon 7 mit Freigabe-Anfrage und 3 Entwürfe. Bei den Entwürfen fand die Gegenprüfung Planfehler; `change_aendern` ist unbeaufsichtigt gesperrt.
  - 6 verknüpft, 4 ohne Verknüpfung; das hat v1968 behoben.
  - Begründet abgelehnt, unter anderem Guacamole: Das eingebettete PostgreSQL 9.6 bräuchte eine Migration.
  - Ohne Wirkung: embyserver.
- **Offen:**
  - Doppeltes CMDB-Asset at-uls2024-media01p: e4c7a51e (unknown) und c615d4a6 (active).
  - B: Web, C: Apps, D: Windows/SQL Server, Netzwerk, Home Assistant direkt, Mail-Regel Bitwarden.
  - Trivy-Dateisystem-Scan der Hosts.
