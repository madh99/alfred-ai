# Bauplan- und Dokument-Vorlagen — wiederholbare Aufbauten mit vorgegebener Dokumentation

Stand: Entwurf 15.11.2026, Weg C (Mischform) vom Owner gewählt. Noch KEINE Freigabe zur Umsetzung.

## 1. Auftrag und Warum (Owner 15.11.2026)

Nach dem PKI-Lab (Changes 2cfde1a2/7335dfeb/288c3716) fragte der Owner:

- **Dokumentation nach Best Practice mit Beweisen.** Die Struktur soll *vorgegeben* sein und von Alfred nur *ausgefüllt* werden — nicht jedes Mal vom Modell neu erfunden.
- **Wiederholbare Abläufe.** Ein zweiter AD-Wald oder ein neues Lab soll nicht jedes Mal komplett neu geplant werden.
- Die Dokumentation muss **drei Zwecken gleichzeitig** dienen (Owner: „für alle drei Varianten … oder jeweils“):
  1. **Wiederaufbau ohne Alfred** — ein Mensch baut das System allein mit dem Dokument wieder auf.
  2. **Nachweis gegenüber Dritten** — Abnahme mit überprüfbaren Belegen.
  3. **Nachschlagewerk** — in der CMDB, versioniert, mit Änderungshistorie.

## 2. Ist-Stand (belegt 15.11.)

- `infra_docs`-Skill (`packages/skills/src/built-in/infra-docs.ts`): Dokumente in `cmdb_documents` (Markdown, Version, Verweis auf Asset/Change/Vorhaben), Versionen/Diff/Revert. Inhalte schreibt das Modell frei; ohne Modell nur ein grobes Gerüst. Bestand: 34 architecture, 29 system_doc, 50 inventory, 3 runbook (April), 2 setup_guide …
- Runbooks: Markdown; `execute_runbook` zerlegt nur nummerierte Listen in Text — keine Verbindung zum Change-Motor.
- Change-Motor: jeder Schritt speichert in `cmdb_change_requests.lauf.ergebnisse` Start, Ende, ok, Ausgabe, Prüfung (Text/Versuche/Ausgabe), Daten. **Das ist das Beweismaterial — es fließt heute in kein Dokument.**
- Standard-Vorlagen (`standard-vorlagen.ts`, `standard-changes.ts`): Vorlagen als Code, einmalige Owner-Freigabe gebunden an Schlüssel+Version+Abdruck, danach Changes **ohne Einzel-Ja**. Owner-Entscheidung 22.10. (5b-11): Netz/Firewall/DNS/VLAN, Datenbanken, Datenlöschung u. a. sind **nie** Standard.
- Bausteine (Skills/Aktionen wie `provision_windows_vm`, `windows_ad.*`, `pki_lab.*`, `unifi.*`) sind deterministischer, getesteter Code und schon wiederverwendbar. **Nur die Orchestrierung** (welche Schritte, Reihenfolge, Prüfungen, Parameter) plant das Modell jedes Mal neu.
- Platzhalter zwischen Schritten existieren (`{{schritt1.thumbprint}}`).
- Bibliotheken `docx` und `pdfkit` sind bereits Abhängigkeiten der CLI.

## 3. Ziele, Nicht-Ziele, Anti-Ziele

**Ziele**
- Z1 Feste Dokumentarten mit Pflichtkapiteln; jedes Kapitel hat eine deterministische Datenquelle. Das Modell füllt nur ausdrücklich freie Felder.
- Z2 Beweis-Anhang automatisch aus den Change-Läufen, prüfbar (Zeitpunkte, Ausgaben, Prüfergebnis, Prüfsumme des Rohlaufs).
- Z3 Export als PDF und DOCX für Wiederaufbau/Nachweis außerhalb von Alfred; dazu Markdown in der CMDB (versioniert).
- Z4 Bauplan-Vorlagen: versionierte, parametrisierte Change-Pakete (auch Ketten wie Aufbau → Test → Abbau), einmal vom Owner freigegeben; Anwendung = Alfred füllt nur Parameter, Ergebnis sind **normale Changes mit Einzel-Freigabe**.
- Z5 Bauplan-Vorlage aus einem erfolgreichen Change(-Paket) ableiten („Vorlage aus 2cfde1a2…“).
- Z6 Jede Bauplan-Vorlage nennt ihre Dokumentart; jeder Schritt kann das Kapitel nennen, für das er Beleg ist. Mit Abschluss des Changes entsteht/aktualisiert sich das Dokument von selbst.
- Z7 Funktioniert mit allen Modellen der Fallback-Kette (Architektur-Grundsatz 29.08.): alles außer Freitextfeldern ist modellunabhängig.

**Nicht-Ziele**
- Keine Ausweitung der Standard-Changes: Bauplan-Vorlagen erlauben **nie** Ausführung ohne Change-Freigabe.
- Keine Umschreibung der vorhandenen 34+ Dokumente (Nachziehen bestehender Systeme ist ein eigener, späterer Schritt — siehe §9).
- Kein grafischer Vorlagen-Editor.

**Anti-Ziele** (würde scheitern, auch wenn es technisch läuft)
- Das Modell erfindet Struktur, Kapitel oder Belege.
- Ein Dokument behauptet etwas, wofür kein Beleg vorliegt (Regel „keine behaupteten Ergebnisse“). Fehlende Daten werden als „nicht belegt“ ausgewiesen, nie geglättet.
- Geheimnisse (Kennwörter, Schlüssel) stehen im Dokument oder im Export. Nur Tresor-Verweise (Name des Eintrags).
- Eine Vorlage umgeht die Change-Prüfung (Validator, Wartungsfenster, Sperrzeiten, Freigabe).

## 4. Weg (Approaches)

| Weg | Kern | Vorteil | Nachteil |
|---|---|---|---|
| A Vorlagen als Code | jede Bauplan- und Dokumentvorlage ein TS-Modul | maximal verlässlich, getestet | jede neue Vorlage braucht einen Release; Alfred kann nicht aus gelungenem Aufbau lernen |
| B Vorlagen als Daten | Markdown/Pläne mit Platzhaltern, von Alfred anlegbar | flexibel | Modell schreibt wieder Struktur → Abdrift; genau das will der Owner nicht |
| **C Mischform (gewählt 15.11.)** | **Dokumentarten, Sammler, Beweis-Anhang, Export als Code; Bauplan-Vorlagen als geprüfte, versionierte Daten mit Owner-Freigabe** | Struktur fest, Vorlagen wachsen ohne Release, heikle Teile deterministisch | Validierung des Vorlagen-Schemas muss streng sein |

## 5. Entwurf

### 5.1 Dokumentarten (Code)

Eine Dokumentart = Liste von Kapiteln; je Kapitel: `id`, Titel, Pflicht ja/nein, **Quelle** (Sammler), optional **ein freies Feld** (max. Länge, Zweck), Regel für „nicht belegt“.

**D-BETRIEB — Betriebsdokument (As-built) für ein System/einen Dienst** (z. B. AD-Wald, SQL-AG, PKI):
1. Zweck und Geltungsbereich — *frei* (≤ 600 Zeichen) + Verweis Vorhaben/Owner-Entscheidungen
2. Architekturüberblick — Diagramm (Mermaid) aus CMDB-Beziehungen + Verweis auf das angenommene Architektur-Dokument
3. Komponenten — Tabelle aus CMDB/Proxmox: Name, VMID, Node, Speicher, vCPU/RAM, OS/Build, IP, Rollen, Lizenzstatus
4. Netz und Firewall — UniFi: Netz/VLAN/Subnetz, Zone, Policies (Richtung, Quelle/Ziel, Ports, ID), DNS-Weiterleitungen; Trunk-Ports
5. Identitäten und Geheimnisse — Dienstkonten/gMSA, Gruppen, **Tresor-Einträge nur als Name**, Fernzugänge
6. Abhängigkeiten — wovon das System abhängt / was davon abhängt (CMDB)
7. **Wiederaufbau** — aus der Bauplan-Vorlage: geordnete Schritte in Menschensprache, je Schritt *was*, *womit* (Werkzeug/Befehl ohne Geheimnisse), *Prüfung* und *Erwartung*; Parameterwerte dieser Instanz
8. Sicherung und Wiederherstellung — PBS-Job/Ausnahmen, Systemstatus/SQL-Sicherungen, letzter Restore-Beweis (Change-ID, Datum, Ergebnis)
9. Überwachung — Jobs, Schwellen, letzte Läufe
10. Betrieb und Wartung — zugeordnete Standard-Vorlagen, Wartungsfenster, offene Problems
11. Änderungshistorie — Changes zu den Assets (ID, Titel, Status, Datum)
12. **Abnahme und Beweise** — Anhang (5.3)
13. Abweichungen und offene Punkte — Halte/Wiederholungen aus den Läufen, offene Befunde; *frei* (≤ 600 Zeichen)

**D-TEST — Lab-/Testprotokoll** (z. B. TLS-Negativtests): Zweck (*frei*), Testumgebung (Komponenten/Netz/Isolation inkl. Isolationsproben), Testfälle (Tabelle: Fall, Erwartung, Ergebnis, Grund, Beleg-Schritt), Befunde für die Produktion (*frei*), Abbau-Nachweis, Beweis-Anhang.

**D-ABNAHME — Change-Abnahmeprotokoll** (für jeden abgeschlossenen Change, auch ohne Vorlage): Kopf (ID, Titel, Plan-Abdruck, Freigabe wann/von wem, Zeitraum), Schrittliste mit Ergebnis, Halte und Wiederholungen, Beweis-Anhang.

Kopf jedes Dokuments: Dokumentart+Version der Dokumentart, Instanz, Erzeugt am, Datenstand je Quelle, Verweise (Vorhaben, Changes, Bauplan-Vorlage+Version).

### 5.2 Datensammler (Code)

Je Quelle ein lesender, deterministischer Sammler (CMDB, Proxmox, UniFi, Tresor-Namen, Fernzugänge, Jobs/job_runs, Change-Läufe, Problems). Rückgabe: strukturierte Daten + Quelle + Zeitpunkt + Fehler. Ein Sammlerfehler macht das Kapitel „nicht belegt (Grund)“, nicht das ganze Dokument kaputt. Nur bestehende lesende Aktionen verwenden; keine neuen Fernbefehle ohne eigenen Bedarf.

### 5.3 Beweis-Anhang (Code)

Je Change, je Schritt: Nr, Titel, Skill/Aktion, Start/Ende (UTC + lokal), Ergebnis, Prüfung (Erwartung/Text/Versuche), Ausgabe gekürzt (Volltext im Rohlauf), Wiederholungen. Am Ende: SHA-256 des vollständigen Rohlauf-JSON je Change, damit ein Dritter den Anhang gegen die Datenbank prüfen kann. Geheimnisse werden vor der Ausgabe mit der bestehenden Maskierung entfernt.

### 5.4 Export (Code)

- Markdown → `cmdb_documents` (neue `doc_type` je Dokumentart, Version +1 bei jeder Aktualisierung, `generated_by='vorlage:<art>@<version>'`).
- PDF und DOCX aus derselben Struktur (nicht aus dem Markdown), gleiche Kapitelnummern.
- Ablageort der Export-Dateien: **Owner-Entscheidung** (§8).

### 5.5 Bauplan-Vorlagen (Daten, streng validiert)

Schema (Version im Schema):
- `key`, `version`, `titel`, `zweck`, `dokumentart`, optional `abbauVorlage` (key).
- `parameter`: Name, Typ (`name`, `ipv4`, `cidr`, `vlan`, `vmid`, `node`, `storage`, `zahl`, `text`, `liste`), Pflicht, Grenzen (Regex/Bereich), Beschreibung, optional **Ableitung** aus anderen Parametern (z. B. Gateway = erste Adresse des CIDR) — Ableitungen sind feste Funktionen im Code, keine Ausdrücke.
- `changes`: geordnete Liste von Change-Gerüsten (Titel, Typ, Risiko, Ausfall, Abhängigkeiten innerhalb der Vorlage) mit `schritte` im heutigen `ChangeSchritt`-Format; Werte dürfen `{{param.x}}` und `{{schrittN.feld}}` enthalten; je Schritt optional `kapitel` (Beleg für Kapitel X).
- Vorab-Prüfungen (`annahmen`) wie bei Standard-Vorlagen: lesend, beim Anwenden und als erster Schritt (z. B. „VMIDs frei“, „VLAN frei“, „Subnetz frei“).

Ablage: neue Tabelle `infra_bauplan_vorlagen` (key, version, json, abdruck, status `entwurf|angefragt|freigegeben|widerrufen`, freigabe_nonce, erstellt/aktualisiert, abgeleitet_aus). Freigabe wie Standard-Vorlagen: Button-Frage mit Zusammenfassung (Zweck, Parameter, Changes, Schritte), gebunden an den Abdruck; jede Änderung → neue Version → neue Freigabe.

**Validierung beim Speichern** (Code): Schema; jeder Skill/jede Aktion existiert; jeder Platzhalter ist auflösbar; Parameter decken alle Platzhalter; Change-Validator läuft probeweise mit Beispielwerten; keine Geheimniswerte im JSON.

### 5.6 Vorlage ableiten (Z5)

Aktion `bauplan_ableiten(changes: [...])`: Code sammelt die Pläne der genannten Changes (in Abhängigkeitsreihenfolge) und schlägt Parameter vor, wo derselbe Wert mehrfach vorkommt oder einem bekannten Typ entspricht (IP, VLAN, VMID, Name). **Hier darf das Modell vorschlagen**, welche Werte Parameter werden und wie sie heißen; das Ergebnis ist ein Entwurf, der dieselbe Validierung durchläuft und vom Owner freigegeben werden muss. Danach ist er fest.

### 5.7 Anwenden

Aktion `bauplan_anwenden(key, parameter)`: nur freigegebene Version; Parameter prüfen (Typ, Grenzen, Annahmen); Platzhalter ersetzen; **normale Changes** über den bestehenden Planungsweg anlegen (Validator, Abhängigkeiten, Wartungsfenster) und **die normale Freigabe anfragen** (ein Ja je Paket, wie bei Serien). Das Modell wählt nur Vorlage und Parameter.

### 5.8 Dokument automatisch

Change-Motor-Hook: Endet ein Change (fertig oder abgebrochen), wird D-ABNAHME erzeugt. Gehört der Change zu einem Bauplan-Paket, wird nach dem letzten Change des Pakets die Dokumentart der Vorlage erzeugt bzw. aktualisiert (neue Version). Manuell: `dokument_erzeugen(art, instanz)` für bestehende Systeme.

### 5.9 Bildschirmfotos

Nur als zusätzlicher Beleg für Oberflächen (UniFi, Proxmox) über den vorhandenen Browser (puppeteer). Server Core hat keine Oberfläche — dort ist die Befehlsausgabe der Beleg. Umfang: **Owner-Entscheidung** (§8).

## 6. Etappen (je eigener Release mit Live-Beweis)

- **V1 Dokumentrahmen + Sammler + Export:** D-BETRIEB/D-TEST/D-ABNAHME, Sammler, Markdown/PDF/DOCX. *Beweis:* D-ABNAHME für 2cfde1a2/7335dfeb/288c3716 und D-TEST „PKI-Lab TLS-Negativtests“ aus den echten Läufen; ein Dritter prüft eine Prüfsumme gegen die DB.
- **V2 Automatik:** Hook im Change-Motor. *Beweis:* nächster echter Change erzeugt sein Abnahmeprotokoll selbst.
- **V3 Bauplan-Vorlagen:** Schema, Tabelle, Validierung, Freigabe, Anwenden. *Beweis:* Vorlage „PKI-Lab“ (Aufbau+Test+Abbau) von Hand aus den drei Changes, freigegeben, erneut angewendet → Lab neu aufgebaut, getestet, abgebaut; D-TEST entsteht automatisch.
- **V4 Ableiten:** `bauplan_ableiten`. *Beweis:* Vorlage aus den I8c-Changes (AD-Wald) abgeleitet und validiert (Anwenden nur auf Wegwerf-Umgebung und nur mit Owner-Freigabe).
- **V5 (optional) Bildschirmfotos.**
- **Nachziehen bestehender Systeme:** D-BETRIEB für AD ad.3033.at, SQL-AG, PKI aus Bestand + alten Change-Läufen — Reihenfolge nach Owner (§8).

## 7. Randbedingungen

- Alle Owner-Regeln gelten unverändert: Ausführung nur über freigegebene Changes; Geheimnisse nur Tresor; ZFS/Hardware Owner-Gebiet; DCs nicht in PBS/keine Snapshots; Cluster-Firewall „Any“.
- Modellunabhängig (Z7); Freitextfelder dürfen leer bleiben, ohne dass das Dokument ungültig wird.
- Datenbankzeiten sind TEXT (ISO mit „T“) — Sammler vergleichen entsprechend.
- Größe: Beweis-Anhang kürzt Ausgaben je Schritt; Volltext bleibt in der DB.

## 7b. Festlegungen nach der Umsetzer-Prüfung (Calls, vom Owner prüfbar)

- **Instanz/Paket:** neue Tabelle `infra_bauplan_instanzen` (id, vorlage key+version, parameter, change-IDs, dokumentart, status). Dokumente werden je **(Dokumentart, Instanz)** versioniert (`linked_entity_type='bauplan_instanz'`). Für V1 ohne Vorlage: Instanz von Hand aus einer Change-Liste anlegen (PKI-Lab: 2cfde1a2, 7335dfeb, 288c3716).
- **Werte über Change-Grenzen:** zuerst Parameter und feste Ableitungen. Zusätzlich neue Verweisart `{{change:<schluessel>.schrittN.feld}}`, nur auf **abgeschlossene Vorgänger-Changes derselben Instanz**, aufgelöst im Motor mit derselben Wert-Sicherheitsprüfung wie `{{schrittN.feld}}`.
- **D-ABNAHME:** für jeden normalen und Notfall-Change; Standard-Changes einer Serie → **ein Sammelprotokoll je Serie**; einzelne Standard-Changes ohne Serie → eigenes Protokoll.
- **Prüfsumme:** SHA-256 über die kanonische JSON-Form (sortierte Schlüssel, UTF-8) von `lauf` **zum Erzeugungszeitpunkt**; der Rohlauf liegt dem Export als JSON-Datei bei, dazu eine kurze Prüfanleitung (sha256sum) — ein Dritter braucht keinen DB-Zugang. Wächst der Lauf später, entsteht eine neue Dokumentversion.
- **Freigabe vs. Code-Änderungen:** Abdruck = Vorlagen-JSON. Bei jedem Anwenden läuft die volle Validierung erneut (Aktionen vorhanden, Parameter-Schemata, Probe-Validator); scheitert sie, geht die Vorlage auf „überprüfen“ (gesperrt, neue Freigabe nötig) — kein stilles Weiterlaufen.
- **„Nie Standard“-Kategorien (5b-11):** gelten für Bauplan-Vorlagen **nicht als Verbot**, weil jede Anwendung normale Changes mit Einzel-Freigabe erzeugt; die Freigabe-Frage nennt diese Kategorien aber ausdrücklich (Netz/Firewall/Löschung …).
- **Widersprüche zwischen Quellen** (CMDB vs. Proxmox/UniFi live): nie still eine Quelle bevorzugen — Live-Wert ins Kapitel, Abweichung in Kapitel 13 (vorhandenen Soll-Ist-Abgleich nutzen, wo es ihn gibt).

## 8. Owner-Entscheidungen 15.11.2026 („wie von dir vorgeschlagen“)

1. **Ablage der Exporte (PDF/DOCX + Rohlauf-JSON + Prüfanleitung):** (b) Zustellung an den Owner (App/Telegram, Ordner auf PC/Mac) **und** (c) Kopie auf dem PBS auf pve2 im anderen Gebäude. Nicht nur auf .92. Hinweis: Wiederaufbau ganz ohne Alfred braucht zusätzlich den offenen Vaultwarden-Spiegel (Geheimnisse stehen nie im Dokument).
2. **Bildschirmfotos:** nur UniFi und Proxmox als Zusatzbeleg, erst in Etappe V5.
3. **Nachziehen bestehender Systeme (D-BETRIEB):** zuerst PKI, dann AD ad.3033.at, dann SQL-AG mit Cluster.
4. **Bauplan-Vorlagen dürfen Netz/Firewall/Lösch-Schritte enthalten** (jede Anwendung = normale Changes mit Einzel-Freigabe; die Freigabe-Frage nennt diese Kategorien ausdrücklich) — Owner hat nicht widersprochen.

## 9. Dem Umsetzer überlassen

Interne Struktur der Module, Mermaid-Erzeugung, PDF/DOCX-Layout im Rahmen der Kapitel, Namen der Aktionen, Tests.

## 10. Umsetzungsstand

- **V1 (v1873, 15.11.2026)** live: Skill `dokumentation` mit Abnahme- und Testprotokoll, CMDB-Versionierung (Struktur + Markdown), PDF/DOCX, geschwärzter Rohlauf mit `PRUEFUNG.txt`, Ablage lokal und auf pve2, Instanzen. Live-Beweis: drei Abnahmen (2cfde1a2, 7335dfeb, 288c3716) und Testprotokoll `pki-lab-2026-11-15`, `sha256sum -c` lokal und auf pve2 OK. Schwärzung (`schwaerze()`) gehärtet.
- **V2 (v1874)**: Abnahmeprotokoll automatisch nach jedem Change-Ende (Sammelprotokoll je Standard-Serie, sofort bei abgebrochener Serie), PDF/DOCX an den Owner, Zeitgrenze 25 s mit Folgemeldung. `PRUEFUNG.txt` nur Prüfzeilen; Verlauf im Motor; für Läufe vor v1873 nur der erste Halt je Lauf belegt (steht so im Dokument).
- **Abweichung vom Etappenplan §6:** D-BETRIEB ist in V1 nur als Definition enthalten; Builder und Live-Sammler (Proxmox/UniFi) folgen im Nachzieh-Plan (PKI → AD → SQL-AG).
- **D-BETRIEB (v1875, 16.11.2026)** live: Aktion `betrieb_erzeugen`, Instanz-Dokumentart `betrieb` (Komponente = alle gleichnamigen Assets; optional `aufbau_changes`, `tresor`; Vorlagen/Jobs beim Anlegen geprüft). Sammler: CMDB, Proxmox (VMs, Jobs, Pools, Snapshots), UniFi (Zonen/Richtlinien/DNS), pfSense/MikroTik/NPM/Cloudflare-Bestand, Changes, Standard-Vorlagen mit Abdruck, Tresor-Namen. Live-Beweis: `pki-ad3033` (ee40f062), `ad-3033` (77effe18), `sql-ag-3033` (2c3b62d2), je 13 Kapitel, Dateien lokal = pve2 (SHA-256). Kapitel 7 nutzt bis V3 die Changes statt einer Bauplan-Vorlage.
- **V3 Bauplan-Vorlagen (v1878–v1880, 16.11.2026)** live: Skill `bauplan` (speichern mit Probe durch den echten Validator, Freigabe per Button gebunden an den Abdruck, anwenden → normale Changes + eine Freigabe-Frage, bei Fehler nach dem Planen werden die Changes verworfen), mitgelieferte Vorlagen (`eingebaut: pki_lab`, im Code statt als Datei — neue Vorlagen brauchen bis zu einem Datei-/Anlage-Eingang einen Release). Verweise `{{change:<schlüssel>.schrittN.feld}}`: abweichend vom Wortlaut §7b nicht auf „dieselbe Instanz“, sondern auf die (transitive) `abhaengigVon`-Kette beschränkt; gebunden an den geplanten Stand des Vorgängers (Abdruck), nur fertige Läufe ohne Rückweg, nur erfolgreiche Schritte; ein Change startet nicht, wenn ein Vorgänger geändert ist oder ein Wert fehlt. Annahmen laufen beim Anwenden live und als erste Schritte der ersten Wurzel; weitere Wurzeln hängen von ihr ab. Testprotokoll entsteht am Paket-Ende von selbst. Live-Beweis: Instanz `pki-lab-2026-11-16` (Aufbau eccb5401 44/44, Test fc1dd710 19/19 mit allen 6 TLS-Fällen, Abbau a500a79d 32/32 nach zwei Halten und Korrektur am Haltepunkt), Testprotokoll d2d423e5 automatisch, `sha256sum -c` OK. Damit auch V2 belegt (Abnahme automatisch für alle drei).
- **Offen nach V3:** `remove_orphan_zone_networks` sucht mit der ID der Integration-API, der Zonenverweis steht unter der internen Netz-ID — wer den Verweis am 16.11. entfernt hat, ist nicht belegt. Scheitert der Test-Change eines Pakets, startet der Abbau nie (Lab bleibt stehen). Dedupe des Testprotokolls nur im Speicher; nach gescheiterter Paket-Frage bleibt die Instanzzeile.
- **Offen (geparkt):** gemeinsamer Versionszähler Einzel-/Sammelprotokoll; Beweis-Tabelle ohne Erwartung/Versuche (nur im Rohlauf); Halte vor v1873 ließen sich zusätzlich aus dem Log („I4 Change angehalten“) rekonstruieren — Owner-Entscheidung.
