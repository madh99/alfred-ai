# Infrastruktur-Vorhaben — Alfred plant, baut, migriert und rüstet hoch (Spec, Entwurf 22.10.2026)

**Status:** Entwurf, **keine Umsetzungsfreigabe**; Owner-Antworten zu den 13 Fragen eingearbeitet (Abschnitt 5b, 22.10.). Owner 22.10.2026: „machen wir bitte E1 bis E5 zuerst die Specs — Docker ist nur ein Beispiel, Alfred sollte in der Lage sein, alles zu planen und zu migrieren, upzugraden, neu in passender Architektur aufzusetzen und Altes zu migrieren; dazu alle möglichen Infra-Skills verwenden — wenn etwas fehlt, besprechen; er sollte auch selbst Proxmox-Cloud-Init-Vorlagen für passende Distributionen anlegen; auch Windows sollte er beherrschen, auch in der Analyse“. Vorher (22.10.): „nach Freigabe sollte er alles erledigen vom VM-Aufsetzen bis Daten migrieren und NPM ändern, UniFi oder pfSense anpassen — am besten über Changes, die geplanten Aufgaben fachlich richtig als Changes erstellen, die man freigeben kann, und er arbeitet diese ab“.

**Einordnung:** Verallgemeinert den „Projektvorgang“ (R1–R5) und die „Stages dev/test/prod“ aus `2026-10-04-jarvis-architektur.md` von Software-Projekten auf Infrastruktur. Baut auf Schicht 3 (Vorgänge, Autonomie-Klassen, Ausführungsgedächtnis) und dem Fernzugriff (v1539–v1552: Zugänge über CMDB, gepinnter Host-Schlüssel, Lese-Käfig, Geheimnis-Sperre, Ausgabe-Seiten, Skill-oder-SSH-Abwägung) auf.

---

## 1. Zielbild

Der Owner gibt ein Ziel in eigenen Worten, z. B.:
- „Auf dem dockerhost läuft fast alles — prüfe, was man auf neue Docker-VMs verteilen könnte, und schlag mir eine Architektur vor.“
- „Bring die drei Debian-11-VMs auf Debian 12.“
- „Setz mir eine Windows-Server-VM für die Buchhaltung auf, mit Freigabe im VLAN Büro.“
- „Die Matrix-Dienste sollen in eine eigene VM mit eigenem Netz.“

Alfred
1. **analysiert** den Bestand (Linux, Windows, Proxmox, Container, Netz, Firewall, Reverse-Proxy, DNS, Zertifikate, Sicherungen) — nur lesend, ohne Rückfrage, Ergebnis in der CMDB;
2. **schlägt eine Zielarchitektur vor** (Dokument) — der Owner entscheidet;
3. **plant Changes** fachlich richtig (Schritte, Prüfungen, Rückwege, Abhängigkeiten, Wartungsfenster, Risiko) — der Owner gibt frei;
4. **arbeitet die freigegebenen Changes ab** — deterministisch, prüft jeden Schritt, hält bei Abweichung an, geht den Rückweg, berichtet;
5. **räumt auf** (alte Dienste erst nach Owner-Freigabe stilllegen/löschen) und hält CMDB, Doku und Lage aktuell.

## 2. Grundsätze (verbindlich)

1. **Modell plant, fester Ablauf führt aus.** Das Modell erstellt Analyse, Architektur und Changes. Die Ausführung eines freigegebenen Changes macht ein deterministischer Motor (E3) — kein freies Improvisieren in langen Ketten. Das Modell wird nur bei einer Abweichung zur Diagnose gefragt und darf dann **nur vorschlagen** (geänderter Change → neue Freigabe). Hintergrund: Alfred muss mit allen Modellen der Fallback-Kette funktionieren (Grundsatz 29.08.).
2. **Freigabe pro Change, nicht pro Befehl.** Das Ja des Owners deckt genau die Schritte dieses Changes (Fingerabdruck über Schritte + Parameter, wie die Einmal-Freigaben v1225). Ändert sich ein Schritt, ist die Freigabe ungültig.
3. **Was nie geht, geht nie.** Zerstörerisches aus der Nie-Liste (mkfs auf belegte Datenträger, zpool destroy, Löschen ohne Sicherung …) ist auch in einem freigegebenen Change gesperrt; Löschen von Altem nur als eigener Change **nach** erfolgreicher Migration und Wartezeit.
4. **Erst sichern, dann ändern.** Jeder Change, der Bestehendes verändert, beginnt mit einer Sicherung, die der Rückweg nutzt (Proxmox-Snapshot, Backup, Konfig-Export von NPM/UniFi/pfSense, Datenkopie).
5. **Geheimnisse nie ans Modell.** Passwörter, Schlüssel, `.env`-Inhalte werden als **Verweise** behandelt (Tresor, siehe E4), übertragen nur Server-zu-Host als Datenstrom. Das Modell sieht Namen, nie Werte.
6. **Jeder Schritt hat eine Prüfung.** Ohne Prüfung kein „erledigt“. Prüfungen sind deterministisch (HTTP-Code, Container healthy, Port offen, DNS löst auf, Datei vorhanden, Prüfsumme gleich).
7. **CMDB ist die Wahrheit.** Bestand, Abhängigkeiten, Zuordnung Dienst → Host → VM → Speicher → Netz → Proxy-Eintrag → DNS. Jeder Change aktualisiert sie.
8. **Skill oder SSH abwägen** (v1550): Fachskill für Überblick/API-Aktionen, Fernzugriff für das, was nur auf dem Host liegt. In Changes bevorzugt API-Aktionen der Fachskills (prüfbarer, rückgängig machbar), SSH nur wo nötig.

## 3. Bausteine heute (Stand v1552)

| Bereich | Vorhanden | Grenze |
|---|---|---|
| Analyse Linux | Fernzugriff: feste Leseliste + Lese-Käfig (jeder lesende Befehl), Docker-Lesebefehle, Ausgabe-Seiten | — |
| Analyse Windows | Alfred-Satellit auf Windows (Bedienen, Befehle mit Bestätigung) | **kein** Fernzugriff für Windows-Server ohne Satellit; kein lesender PowerShell-Weg |
| Proxmox | clone_vm (Cloud-Init: Hostname, IP, Gateway, SSH-Schlüssel; Laufzeit docker/node/python nachinstalliert), create_lxc, Snapshots, backup_vm, migrate_vm, start/stop, list_templates, list_storage/networks, backups_vm (v1543) | **keine** Vorlagen-Erzeugung (Cloud-Image laden, Disk importieren, Cloud-Init-Laufwerk, in Vorlage umwandeln); keine Netz-/Bridge-/VLAN-Konfiguration; Windows-VM nur aus vorhandener Vorlage |
| Container | Docker-Skill (containers, logs, compose_up/down/ps, pull, restart …), Fernzugriff | Compose-Projekte von Host zu Host verschieben fehlt |
| Ausrollen | Deploy-Skill (deploy, provision, setup_node/python, rollback, logs) | auf Git-Projekte zugeschnitten |
| Reverse-Proxy | NPM: list/create/update/delete_host, list_certificates | Zertifikat anfordern/erneuern einzeln prüfen |
| DNS extern | Cloudflare: Zonen, Records anlegen/ändern/löschen | interne DNS-Einträge (UniFi/pfSense/Pi-hole?) offen |
| Firewall/Netz | UniFi: Firewall-Policies (zonenbasiert), Netze lesen, next_free_ip, Clients; pfSense: Regeln, Schnittstellen, VLANs, Gateways, DHCP-Leases lesen; MikroTik: umfangreich | UniFi: Netze/VLANs **anlegen**, DHCP-Reservierung fehlen; pfSense: NAT/Port-Forward, DHCP-Statik, Aliase fehlen |
| Sicherung | Proxmox-Backups (backups_vm), Monitor PBS-Prüfung, Commvault-Skill | PBS als eigener Skill (Jobs, Wiederherstellen, Verify) fehlt; Commvault/PBS aktuell nicht erreichbar (Befund 22.10.) |
| Changes | ITSM: create/approve/start/complete/rollback_change mit **Freitext**-Plan | keine strukturierten Schritte, keine Ausführung |
| Doku | Infra-Docs (Runbooks, Netz-/System-/Service-Doku, Topologie), CMDB discover | Architektur-Dokument als Vorlage fehlt |
| Datenbanken | Database-Skill (Abfragen) | Dump/Restore ohne Modell fehlt |

## 4. Etappen

### E1 — Bestandsaufnahme und Zielarchitektur (nur lesend)

**Ziel:** Ein vollständiges, prüfbares Bild des Ist-Zustands und ein begründeter Architektur-Vorschlag.

**Erfassen (je Plattform, deterministische Sammler statt freier Befehle):**
- *Proxmox:* Knoten, Ressourcen, VMs/CTs (CPU/RAM/Disk, Auslastung 7 Tage), Speicher, Netze/Bridges/VLANs, Vorlagen, Snapshots, Sicherungen, HA, Replikation.
- *Linux-Host:* OS/Version/Kernel, Pakete mit Updates, Dienste (systemd), offene Ports (`ss`), Datenträger/Dateisysteme, Cron, Benutzer (ohne Geheimnisse), Konfigdateien wichtiger Dienste (nginx, postgres …).
- *Docker:* Container, Images (Alter, Updates), Compose-Projekte (Pfad, Dienste), Volumes/Bind-Mounts mit Größe, Netze, Ports, Healthchecks, Abhängigkeiten (Links, Netze, Umgebungs-**Namen** ohne Werte), Ressourcenverbrauch.
- *Windows:* siehe E4-W (Lesen über PowerShell): OS/Build/Patchstand, Rollen/Features, Dienste, Freigaben, Programme, Aufgabenplanung, Datenträger, Netzwerk, Ereignisprotokoll-Fehler.
- *Netz:* UniFi/pfSense/MikroTik-Netze, VLANs, Firewall-Regeln, DHCP, Port-Forwards; NPM-Proxy-Einträge → Ziel-Host/Port; DNS-Einträge (Cloudflare, intern).
- *Sicherung:* je VM/Dienst letzte Sicherung, Ort, Alter, geprüft ja/nein (wie v1543).

**Ergebnis:**
- CMDB-Einträge mit Beziehungen (Dienst → Container → Volume → Host → VM → Speicher; Proxy → Dienst; DNS → Proxy).
- **Bestandsbericht** (Dokument): Auffälligkeiten (veraltet, unsicher, ohne Sicherung, unhealthy, überlastet, Einzelpunkte).
- **Zielarchitektur** (Dokument, Vorlage fest): Gruppierung (z. B. „Smart Home/Energie“, „Matrix“, „Web-Entwicklung“, „Datenbanken“, „Fernzugriff“), VM-Größen, Distribution je Gruppe, Netze/VLANs und Firewall-Zonen, Proxy/DNS, Sicherungskonzept, Updatestrategie, Reihenfolge der Migration, Risiken, erwartete Ausfallzeiten, Kosten (RAM/Disk auf den Knoten).
- Der Owner kommentiert/entscheidet; erst daraus entstehen Changes (E2).

**Neu zu bauen:** Sammler je Plattform (feste Befehlssätze, Ergebnis strukturiert), CMDB-Abgleich, Dokumentvorlagen Bestand/Architektur.

### E2 — Vorhaben und Changes mit Schritten

**Datenmodell:**
- **Vorhaben** (z. B. „Dockerhost aufteilen“): Ziel, Architektur-Dokument, Changes, Status, Owner-Entscheidungen.
- **Change** (ITSM, erweitert): Titel, Begründung, Risiko (niedrig/mittel/hoch), Wartungsfenster, betroffene Dienste (CMDB), Abhängigkeit von anderen Changes, erwartete Ausfallzeit, **Schritte**, Rückweg gesamt, Abschlussprüfung.
- **Schritt:** `{ art: aktion | pruefung | warten | owner, skill, aktion, parameter, prueffall, rueckweg, zeitlimit, bei_fehler: anhalten|rueckweg|weiter }`. Parameter dürfen auf Ergebnisse früherer Schritte verweisen (`{{schritt3.vmid}}`) und auf Tresor-Einträge (`{{geheim:matrix-db-passwort}}`, nie aufgelöst im Modell).

**Schritt-Katalog (erste Fassung):** proxmox (vorlage_erstellen*, clone_vm, create_lxc, snapshot, backup_vm, start/stop, migrate_vm), fernzugriff (lesen, ausfuehren, kopieren*), docker (compose_up/down/ps, pull_image, restart), deploy (provision, setup_*), nginx_proxy_manager (create/update_host, Zertifikat*), cloudflare_dns (create/update_record), unifi (Policy anlegen/aktivieren, Netz*/DHCP-Reservierung*), pfsense (Regel, NAT*, DHCP*), cmdb (add/update_asset, add_relation, decommission), pruefung (http, port, dns, container_healthy, datei, pruefsumme, befehl_exit0), warten (bis Bedingung / Zeit), owner (Rückfrage/Bestätigung mitten im Change, z. B. „DNS umstellen?“). *= fehlt heute (E4/E5).

**Prüfung beim Anlegen** (wie `eingabeFehler` v1537, erweitert): Skill/Aktion vorhanden, Pflichtparameter, Verweise auflösbar, Nie-Liste, Rückweg vorhanden für jede ändernde Aktion, Sicherung vor ändernden Schritten, Abhängigkeiten ohne Zyklus. Ungültige Changes können nicht freigegeben werden.

**Darstellung:** App/Web: Vorhaben → Changes mit Schritten, Risiko, Fenster, Diff (vorher/nachher) für Proxy/DNS/Firewall; Freigabe-Knopf pro Change oder „Paket freigeben“.

### E3 — Ausführungsmotor

- **Zustandsmaschine je Change:** geplant → freigegeben → wartet auf Fenster → läuft (Schritt n) → geprüft → abgeschlossen | angehalten | zurückgerollt | fehlgeschlagen. Persistiert in der DB, **überlebt Neustarts** (Selbstupdate wartet auf laufende Changes).
- **Ablauf je Schritt:** Parameter auflösen (Ergebnis-Verweise, Tresor nur im Motor) → ausführen über die Skill-Sandbox mit Change-Freigabe als Berechtigung → Prüffall → Ergebnis ins Ausführungsgedächtnis und in den Change.
- **Abweichung:** anhalten, Owner melden (Push/Telegram, Lage „Braucht dich“), Rückweg nur, wenn im Schritt so festgelegt oder der Owner es wählt; das Modell darf eine Diagnose und einen **geänderten** Change vorschlagen (neue Freigabe).
- **Wartungsfenster:** Start nur im Fenster; Ankündigung vorher (Push), Abschlussmeldung mit Prüfergebnissen.
- **Sichtbarkeit:** Lage/Widget zeigt laufende Changes; Live-Aktivität optional für lange Changes.
- **Grenzen:** höchstens ein ändernder Change je Host gleichzeitig; Zeitlimit je Schritt; Abbruchknopf.

### E4 — Querschnitts-Bausteine

**E4-D Daten übertragen (Host → Host, ohne Modell):**
- Datei/Ordner/Volume: Strom `tar`/`rsync` über den Server (Quelle-SSH → Ziel-SSH), Prüfsumme danach; zwei Durchgänge (bei laufendem Dienst vorkopieren, Dienst stoppen, Rest abgleichen).
- Docker-Volume: über einen Hilfscontainer exportieren/importieren.
- Datenbank: Dump/Restore (pg_dump/pg_restore, mysqldump, mongodump) als Strom, nie als Text im Modell; Prüfung: Zeilenzahlen/Prüfsummen.
- Große Mengen: Fortschritt, Fortsetzen nach Abbruch, Bandbreitengrenze.

**E4-G Geheimnisse (Tresor):** Werte verschlüsselt am Server (vorhandener `envEncryptionKey`/`project_environments` erweitern), Einträge mit Namen, Herkunft, Zweck; beim Migrieren werden `.env`/Compose-Geheimnisse vom Quell-Host direkt in den Tresor gelesen und auf dem Ziel geschrieben — Modell sieht nur Namen. Optional Vaultwarden als Quelle (Owner-Entscheidung).

**E4-H Neue Hosts automatisch verwaltet:** Was Alfred anlegt, bekommt per Cloud-Init seinen Fernzugriff-Schlüssel und Benutzer `alfred` (sudo nach Owner-Vorgabe), Host-Schlüssel wird beim ersten Start über die Proxmox-Konsole/Cloud-Init-Ausgabe festgehalten (statt ungeprüftem keyscan), Eintrag in CMDB und Fernzugängen, Käfig-Selbsttest.

**E4-V Vorlagen-Fabrik (Proxmox):**
- *Linux-Cloud-Images:* offizielle Images (Debian 12/13, Ubuntu 24.04 LTS, Rocky/Alma 9, ggf. Alpine/Fedora) laden, Prüfsumme gegen Herausgeber-Signatur prüfen, Disk importieren, Cloud-Init-Laufwerk, qemu-guest-agent, serielle Konsole, als Vorlage markieren, Name mit Version und Datum, CMDB-Eintrag.
- *Grundhärtung je Vorlage:* SSH nur Schlüssel, unattended-upgrades/dnf-automatic nach Owner-Wahl, Zeit/Locale, Docker-Variante optional.
- *Aktualisierung:* Vorlagen monatlich neu bauen (Job-Register), alte behalten bis keine VM mehr darauf verweist.
- *LXC:* Appliance-Vorlagen über pveam aktualisieren/laden.
- *Auswahl:* E1/E2 wählen die Distribution je Aufgabe (Begründung im Architektur-Dokument, z. B. Debian für Server-Dienste, Ubuntu wo Hersteller es verlangen, Rocky für RHEL-Abhängigkeiten).

**E4-W Windows:**
- *Analyse:* OpenSSH-Server unter Windows (Bordmittel) + PowerShell. Lesender Weg: feste Liste von `Get-*`-Befehlen (Get-ComputerInfo, Get-Service, Get-HotFix, Get-WindowsFeature, Get-SmbShare, Get-ScheduledTask, Get-Volume, Get-NetIPConfiguration, Get-WinEvent mit Filter …) plus — als Gegenstück zum Lese-Käfig — ein **JEA-Endpunkt** (Just Enough Administration) mit nur lesenden Befehlen, oder ein eigenes Konto ohne Schreibrechte. Ausgaben als JSON (`ConvertTo-Json`) für strukturierte Sammler.
- *Ausführen:* über Changes (PowerShell-Schritte mit Prüfung und Rückweg); Neustarts als eigene Schritte mit Warten.
- *Aufsetzen:* Windows-Vorlage aus ISO + VirtIO-Treibern + `autounattend.xml` + Cloudbase-Init (Cloud-Init-Gegenstück), sysprep, als Vorlage; danach wie Linux klonen (Hostname, IP, Admin-Konto über Tresor). Lizenz/Aktivierung bleibt Owner-Sache.
- *Alternative:* Alfred-Satellit auf Windows-Servern (vorhanden, mit Befehlssignatur „streng“) — gut für dauerhaft verwaltete Rechner; OpenSSH/JEA für reine Server-Verwaltung ohne Agent. Owner-Entscheidung.

**E4-N Netz-Aktionen ergänzen:** UniFi Netz/VLAN anlegen, DHCP-Reservierung; pfSense NAT/Port-Forward, DHCP-Statik, Aliase; internes DNS (wo liegt es: UniFi, pfSense, Pi-hole?); NPM Zertifikat anfordern; jeweils mit Konfig-Export vorher (Rückweg).

### E5 — Erste echte Läufe (Beweise)

1. **Analyse-Lauf** dockerhost + pve-Cluster (E1) → Bestandsbericht + Architektur-Vorschlag → Owner-Entscheidung.
2. **Vorlage** Debian 12 Cloud-Init bauen und eine Wegwerf-VM daraus starten (E4-V, E4-H) — Beweis: VM erreichbar, Fernzugang aktiv, Käfig aktiv, CMDB-Eintrag.
3. **Migration unkritisch:** ein Container (z. B. Dashy oder pgAdmin) vom dockerhost in eine neue Docker-VM — mit NPM-Umstellung und Firewall-Policy, Rückweg geprobt.
4. **Upgrade:** eine unkritische Debian-VM eine Hauptversion höher — entweder an Ort und Stelle (Snapshot vorher) oder neu aus Vorlage + Daten migrieren (Architektur-Entscheidung).
5. **Windows:** Analyse eines vorhandenen Windows-Rechners (lesend), danach Windows-Vorlage + Wegwerf-VM.
Erst danach: kritische Dienste (Home Assistant, Matrix, Datenbanken).

## 4b. Volle Verknüpfung mit ITSM und CMDB

Owner 22.10.: „natürlich sollte das auch mit ITSM und CMDB vollumfänglich verknüpft bzw. integriert sein“. Grundsatz: **kein paralleles System** — Vorhaben, Changes und Bestand leben in den vorhandenen ITSM-/CMDB-Strukturen und erweitern sie.

**Changes = ITSM-Changes (erweitert, nicht daneben)**
- Ein Change aus E2 ist ein ITSM-Change (`create_change_request` …) mit zusätzlichem Feld *Schritte*; Freitext-Plan, Rückweg und Testplan werden aus den Schritten erzeugt (lesbar), bleiben aber nicht die Quelle.
- **Change-Typen nach ITIL:** *Standard-Change* (vorab freigegebene Vorlage für wiederkehrende, risikoarme Abläufe — z. B. „Snapshot anlegen“, „Container-Image aktualisieren mit Rückweg“, „Vorlage neu bauen“; einmal freigegeben, danach ohne Einzel-Ja innerhalb festgelegter Grenzen), *Normal-Change* (Freigabe je Change), *Notfall-Change* (bei Störung, mit nachträglicher Prüfung).
- **Auswirkungsanalyse aus der CMDB** vor der Freigabe: betroffene Dienste, abhängige Dienste (`impact_analysis`/`service_impact_analysis`), SLA, erwartete Ausfallzeit — steht im Change und in der Freigabe-Ansicht.
- **Konflikte und Sperrzeiten:** kein Change auf Assets mit offenem kritischem Incident (außer Notfall-Change); keine zwei überlappenden Changes auf denselben Assets; optionale Sperrzeiten (Owner).
- **Nachbetrachtung (PIR):** nach Abschluss Ergebnis, Abweichungen, Dauer, tatsächliche Ausfallzeit in den Change (`pir_pending` vorhanden); Erfahrungen fließen in Vorlagen und Runbooks.

**Incidents und Problems**
- Ein Schritt scheitert → Incident, verknüpft mit Change und Asset; Rückweg ausgeführt → im Incident dokumentiert.
- **Change-verursachte Störungen:** Meldet das Monitoring in einem Zeitfenster nach einem Change eine Störung an betroffenen Assets/Diensten, wird der Incident automatisch mit dem Change verknüpft (Hinweis „möglicherweise durch Change X“) und der Rückweg als Vorschlag angeboten.
- **E1-Befunde werden ITSM-Objekte:** fehlende Sicherung, veraltete Distribution, unhealthy Dienst, Einzelpunkt → Problem/Known Error (mit Dedup wie v1547); ein Vorhaben kann aus Problems entstehen und schließt sie beim Abschluss (`create_fix_change`, `link_incident_to_problem` vorhanden).

**CMDB als Wahrheit, laufend gepflegt**
- Jeder Schritt mit Wirkung aktualisiert die CMDB **im selben Ablauf** (neue VM → Asset; Container umgezogen → Beziehung neu; Proxy-Ziel geändert → Beziehung; Altes → `decommission_asset` nach dem Lösch-Change). Änderungen tragen den Change als Ursache (`logChange` → Änderungsverlauf je Asset).
- **Soll/Ist:** Die Zielarchitektur wird als *geplanter* Zustand in der CMDB abgelegt (Status „geplant“); nach jedem Change Abgleich Soll ↔ Ist, Abweichungen als Befund.
- **Discovery nach dem Change:** gezieltes `discover_source` der betroffenen Quellen (Proxmox, Docker, UniFi …) als Abschlussprüfung — die CMDB muss den neuen Zustand selbst sehen.
- **Dienste/Services:** ITSM-Services und Komponenten (`add_component`/`remove_component`), Failure-Modes und SLA ziehen mit um; Service-Doku und Topologie (Infra-Docs `generate_service_doc`, `topology_diagram`, `service_map`) werden nach jedem Change neu erzeugt.
- **Runbooks:** aus einem erfolgreich abgearbeiteten Change entsteht auf Wunsch ein Runbook bzw. eine Standard-Change-Vorlage („so migriert man einen Compose-Dienst“).

**Sichtbar in App/Web:** Vorhaben → Changes → Schritte mit Verweisen auf Assets, Services, Incidents, Problems; je Asset die Change-Historie; Lage zeigt laufende und anstehende Changes, „Braucht dich“ die offenen Freigaben.

## 5. Lücken zum Besprechen (Owner-Entscheidungen)

1. **Wo liegt internes DNS?** (UniFi, pfSense, Pi-hole, AdGuard …) — davon hängt E4-N ab.
2. **pfSense im Einsatz?** Gateway ist die UniFi Dream Machine Pro; pfSense-Skill existiert — welche Rolle hat pfSense heute (zweite Firewall, Labor)?
3. **Sicherung:** PBS (pbs-unas) und Commvault sind aktuell nicht erreichbar. Soll ein **PBS-Skill** (Jobs, Wiederherstellen, Verify) gebaut werden, und welches System ist künftig führend?
4. **Windows-Weg:** OpenSSH + JEA (agentenlos) oder Alfred-Satellit je Windows-Server — oder beides je nach Rolle?
5. **Tresor:** eigener verschlüsselter Speicher am Server (Vorschlag) oder Vaultwarden als Quelle?
6. **sudo auf neuen Hosts:** volle Rechte wie bisher (Schutz durch Changes/Käfig) oder eingeschränkte sudo-Regeln je Rolle?
7. **Wartungsfenster:** Standardzeiten (z. B. werktags 22–06 Uhr, Wochenende frei)? Wer wird vorher informiert (nur Owner, Familie bei Home Assistant)?
8. **Updates in Vorlagen und VMs:** automatische Sicherheitsupdates ja/nein; Hauptversions-Upgrades immer als Change.
9. **Netz-Zielbild:** eigene VLANs je Gruppe (Smart Home, Server, Entwicklung, Gäste) als Teil der Architektur oder vorerst flaches Netz behalten?
10. **Löschen von Altem:** Wartezeit nach erfolgreicher Migration (Vorschlag 14 Tage gestoppt behalten), dann eigener Change.
11. **Standard-Changes:** Welche wiederkehrenden Abläufe dürfen nach einmaliger Freigabe ohne Einzel-Ja laufen (Vorschlag: Snapshot anlegen/löschen eigener Snapshots, Vorlage neu bauen, Container-Image aktualisieren mit Rückweg)?
12. **Sperrzeiten:** gibt es Zeiten ohne Changes (z. B. Wochenende, Urlaub)?
13. **Change-verursachte Störungen:** Zeitfenster für die automatische Verknüpfung (Vorschlag 24 h) und ob der Rückweg dann nur vorgeschlagen oder bei kritischen Diensten selbst ausgeführt werden darf.

## 5b. Owner-Antworten 22.10.2026 (Spec-Stand, weiterhin keine Umsetzungsfreigabe)

| # | Antwort des Owners | Folge für die Spec |
|---|---|---|
| 1 | Internes DNS liegt in **UniFi** | E4-N: lokale DNS-Einträge über den UniFi-Skill (neue Aktionen: lokale Einträge lesen/anlegen/ändern/löschen); E1 liest sie in die CMDB (DNS → Proxy/Host). |
| 2 | WAN mit **mehreren öffentlichen IPs**; **pfSense** und **MikroTik** wurden u. a. für IPv6 und verschiedene VLANs eingerichtet | E1 muss die Netz-Topologie über **alle drei** Geräte erfassen (welches Gerät routet welches Netz/VLAN, welche WAN-IP wohin, IPv6-Präfixe, NAT/Port-Forwards je Gerät). Changes an Netz/Firewall wählen das richtige Gerät aus der CMDB; Architektur-Vorschlag benennt die Rolle je Gerät. |
| 3 | **PBS-Skill ja** | Neuer Skill `pbs` (Datastores, Jobs, Snapshots/Gruppen, Verify, Prune/GC lesen, Wiederherstellen als Change-Schritt, Erreichbarkeit). Führendes Sicherungssystem wird Teil des Architektur-Vorschlags. |
| 4 | Windows: **beides** möglich | E4-W: OpenSSH + PowerShell + JEA (agentenlos) **und** Alfred-Satellit; Wahl je Host im Architektur-Vorschlag bzw. CMDB-Feld „Verwaltungsweg“. |
| 5 | Tresor: Vorschlag erbeten | **Vorschlag:** eigener Tresor am Server — Alfred muss Geheimnisse unbeaufsichtigt nutzen können (Changes im Wartungsfenster), Vaultwarden bräuchte dafür ohnehin ein dauerhaft entsperrtes Konto am Server. Umsetzung: AES-256-GCM, eigener Tresor-Schlüssel (Datei 600, getrennt vom envEncryptionKey), jeder Zugriff protokolliert (wer/welcher Change/wann, ohne Wert), Werte nie an das Modell, nie in Logs. **Plus Spiegel nach Vaultwarden (optional, nur schreibend):** neu erzeugte oder übernommene Geheimnisse legt Alfred zusätzlich als Eintrag im Vaultwarden des Owners ab, damit der Owner sie dort findet und sichert; Import aus Vaultwarden auf Wunsch einzeln. |
| 6 | **sudo voll** auf neuen Hosts | Cloud-Init-Vorlagen legen `alfred` mit voller sudo-Regel an (Owner-Entscheidung, Schutz durch Changes/Käfig/Nie-Liste). |
| 7 | **Wartungsfenster-Kalender** und hinterlegbar, **wer wann wie** informiert wird | Neu: *Wartungsfenster* (wiederkehrend oder einmalig, global oder je Service/Asset/Gruppe/VLAN) und *Benachrichtigungsregeln* (Empfänger: Owner, Familienmitglieder, weitere Kontakte; Kanal: Push, Telegram, E-Mail, Home-Assistant-Benachrichtigung; Zeitpunkte: z. B. 24 h vorher, 1 h vorher, Start, Ende, bei Störung/Abbruch; je Service, z. B. Home Assistant → Familie). Pflege in App/Web, im Chat („nächste Woche Dienstag 22–24 Uhr Wartung Matrix, informiere Alexandra“). Der Motor startet ändernde Changes nur im passenden Fenster. |
| 8 | Automatische Sicherheitsupdates **ja, optional mit Schalter; wenn aus → Info** | Vorlagen und verwaltete Hosts: Schalter je Host/Gruppe (Standard an); ist er aus, meldet Alfred anstehende Sicherheitsupdates (Lage + Befund + Info nach den Benachrichtigungsregeln) und kann sie als Standard-Change vorschlagen. |
| 9 | **Mit VLANs arbeiten** | Architektur-Vorschlag mit VLAN je Gruppe und Firewall-Zonen; Netz-Changes (VLAN/Netz anlegen, DHCP, Firewall-Zonen) über UniFi bzw. pfSense/MikroTik je nach Rolle (Punkt 2). |
| 10 | Altes **mindestens 7 Tage** stehen lassen, **pro Fall** anders entscheidbar | Lösch-Change frühestens 7 Tage nach erfolgreicher Migration (gestoppt, nicht gelöscht); Frist im Change änderbar, nie unter 7 Tagen ohne ausdrückliche Owner-Angabe im Change. |
| 11 | Standard-Changes: Vorschlag erbeten | **Vorschlag** — vorab freigegebene Abläufe mit festen Grenzen, einzeln widerrufbar: (a) Snapshot anlegen und eigene Snapshots nach Ablauf löschen; (b) Vorlage neu bauen (Vorlagen-Fabrik); (c) Sicherheitsupdates einspielen im Wartungsfenster mit Snapshot vorher und Prüfung nachher (nur Hosts mit Schalter „an“); (d) Container-Image derselben Hauptversion aktualisieren mit Snapshot/altem Image als Rückweg — nur Dienste mit Healthcheck, **nicht** Datenbanken und Home Assistant; (e) Dienst/Container neu starten bei „unhealthy“, höchstens 1× je Tag und Dienst; (f) NPM-Zertifikat erneuern; (g) Wegwerf-/Test-VM aus Vorlage im Test-VLAN anlegen und nach Ablauf löschen (Grenze: 2 vCPU/4 GB/32 GB, höchstens 3 gleichzeitig). **Nie Standard:** Firewall/DNS/Netz/VLAN, Datenbanken, Datenlöschung, Hauptversions-Upgrades, Migrationen, Windows-Neustarts von Servern mit Rollen. |
| 12 | Sperrzeiten sollen **gepflegt werden können** | Sperrzeiten-Kalender (global oder je Service/Gruppe), Pflege wie Wartungsfenster; optional „Abwesenheit des Owners“ aus dem Kalender als Sperrzeit für nicht dringende Changes. |
| 13 | Zeitfenster: Vorschlag erbeten; **Rückweg nur vorschlagen, dann auf Freigabe warten** | **Vorschlag:** Verknüpfung, wenn innerhalb von **24 h** nach Abschluss (bei als kritisch markierten Services **72 h**) ein Incident oder Monitoring-Befund ein Asset/Service des Changes oder einen direkt abhängigen (CMDB) betrifft. Alfred meldet sofort (Push „zeitkritisch“), hängt Change, Prüfergebnisse und Rückweg an und **wartet auf die Freigabe** des Rückwegs — er geht ihn nie selbst. |

**Owner 22.10. (Annahme cf82f3f2):** Netz — Alfred entscheidet selbst, ob ein neues VLAN nötig ist oder Default reicht, legt VLANs selbst an und wählt selbst das Gerät (UniFi oder pfSense) → die Netz-Aktionen aus E4-N (I7) werden vor dem ersten Umzug gebraucht, Owner-Schritte für VLANs sind nur Übergang. Sicherung — Ziel legt vorerst der Owner fest; sobald die Backup-Infrastruktur funktioniert, plant Alfred Sicherungen in den Changes mit (PBS-Skill I4c).

**Weitere Folgen:** Wartungsfenster, Sperrzeiten, Benachrichtigungsregeln und Standard-Changes sind eigene, in App/Web pflegbare Objekte (Teil von I3/I4b); UniFi-DNS-Aktionen und PBS-Skill kommen in I7 bzw. als eigenes Release vor dem ersten Lauf mit Sicherungs-Bezug.

## 6. Vorgeschlagene Reihenfolge der Umsetzung (je Release mit Live-Beweis)

- **I1** E1-Sammler Linux/Proxmox/Docker/Netz + CMDB-Abgleich + Bestandsbericht (lesend) → Beweis: Bericht dockerhost/pve.
- **I2** Architektur-Dokumentvorlage + Vorhaben-Datenmodell (ohne Ausführung) → Beweis: Architektur-Vorschlag dockerhost.
  - *Stand 22.10.:* I1 umgesetzt (v1553/v1554, Bestandsbericht a9be7696). I2 umgesetzt (v1555/v1556): Tabelle `infra_vorhaben`, Skill-Aktionen vorhaben_anlegen/_liste/_zeigen, grundlage, architektur_vorschlagen, entscheiden; deterministische Prüfung (Zuordnung aller Einheiten, Knoten/Speicher je Knoten, VLAN/Subnetz ohne Überschneidung, Firewall strukturiert Zone/Protokoll/Ports, Reihenfolge, Risiken); Dokument mit 12 Pflichtabschnitten (CMDB `architecture`, verknüpft `vorhaben`). Live: Vorhaben cf82f3f2 „Dockerhost auf neue Docker-VMs aufteilen“, Version 2 (Dokument 5859352f) ohne Prüfhinweise — Owner-Entscheidung offen. Nebenbei behoben: Proxmox-Speicher standen alle „inactive“ in der CMDB.
- **I3** Change-Schritte als Erweiterung der ITSM-Changes + Prüfung beim Anlegen + Auswirkungsanalyse aus der CMDB + Darstellung/Freigabe in App/Web (E2, 4b).
  - *Stand 22.10.:* umgesetzt (v1557–v1559). Changes mit Schritten in `cmdb_change_requests`; Prüfung beim Anlegen (Paket alles-oder-nichts); Auswirkung nur über Abhängige; Freigabe per Button (Hash der Einmal-Freigabe am Change, 24 h, an den Fingerabdruck gebunden) oder Web; zentrale Sperre im Repository. Live: Probe-Change 26c8add8 (test-ubuntu, Snapshot i3probe) geplant, vom Owner per iPhone freigegeben, durch Überarbeitung verfallen (wie vorgesehen), neue Frage offen; Selbstgenehmigung über itsm.approve_change abgewiesen. Darstellung im Web (ITSM → Changes), App öffnet die Web-Seite (Owner-Entscheidung 1.71.0).
- **I4** Ausführungsmotor (E3) mit Prüf-Schritten, Rückweg, Neustartfestigkeit, CMDB-Pflege je Schritt, Incident bei Fehlschlag, PIR — Beweis mit einem harmlosen Change (Snapshot anlegen, prüfen, löschen).
  - *Stand 22.10.:* umgesetzt (v1560–v1562; Owner „ja, einspielen“ — Fernzugriff-Befehle mit Change-Freigabe ohne Einzelrückfrage, Nie-Liste bleibt). Erster echter Lauf 26c8add8 (test-ubuntu): Snapshot i3probe angelegt (Proxmox-Aufgabe verfolgt), geprüft, gelöscht — danach angehalten, weil die geplante Prüfung des Löschschritts unerfüllbar war (erwartet „… nicht vorhanden“); Incident 15de4ad6, Meldung an den Owner; VM 142 lesend nachgeprüft: keine Snapshots. v1561 weist solche Prüfungen beim Planen ab; v1562 prüft die Freigabe vor jedem Schritt (Sicherheitsbefund).
- **I4b** Standard-Changes, Change-verursachte Störungen (Monitoring ↔ Change), E1-Befunde als Problems, Soll/Ist-Abgleich (4b); Wartungsfenster-/Sperrzeiten-Kalender und Benachrichtigungsregeln (5b-7/12).
  - *Stand 22.10.:* Teil 1 Wartungsfenster/Sperrzeiten/Benachrichtigungen (v1563/v1564: Tabellen infra_kalender/infra_benachrichtigungen, Motor startet nur nach Zeitplan, 24 h/1 h-Ankündigung verschiebt den Start, Kanäle Push/Telegram/Matrix/E-Mail/HA, Web-Seite „Wartung“) — live: Anlegen/Liste/Entfernen über Web-API, „alex“ mit Matrix-Konto aufgelöst. Teil 2 Störungen nach Changes (v1565, Job change-stoerungen, Rückweg nur als Frage) — getestet, Live-Fall offen. Teil 3 Befunde als Problems (v1566) — live: 9 Problems, zweiter Lauf 0 neu/9 bekannt, Sicherung ausgenommen. Teil 4 Standard-Changes (v1567): Vorlagen a (Snapshot anlegen/aufräumen), c (Sicherheitsupdates, Schalter je Host — vorhandene Hosts aus), d (Image gleiche Hauptversion), e (Neustart unhealthy 1×/Tag); b/g folgen I5 (Proxmox-Skill kann VMs nicht löschen), f folgt I7; einmalige Owner-Freigabe je Vorlage per Button — live: Liste, Freigabe-Frage snapshot_anlegen gestellt. Dazu Cloudflare in der Bestandsaufnahme nachgezogen (Lücke I1, Owner-Frage): DNS je Proxy-Domain, 41 Beziehungen DNS → Proxy. Offen: Teil 5 Soll/Ist (nach angenommener Architektur).
- **I4c** PBS-Skill (5b-3) und Tresor mit optionalem Vaultwarden-Spiegel (5b-5).
- **I5** Vorlagen-Fabrik Linux + neue Hosts automatisch verwaltet (E4-V, E4-H) → Beweis Debian-Vorlage + Wegwerf-VM.
  - *Stand 22.10. abends:*
    - I4c Tresor umgesetzt (v1572); PBS-Skill zurückgestellt, weil pbs-unas nicht erreichbar ist; Vaultwarden-Spiegel offen.
    - Einwand, Soll/Ist und Netz-Aktionen umgesetzt (v1568–v1571).
    - Sichtbarkeit (v1574): ITSM zeigt wartende und abgeschlossene Changes; neue Web-Seite „Vorhaben“.
    - I5 umgesetzt (v1575), Proxmox-Aktionen:
      - `list_cloud_images`: datierter Stand und Prüfsumme der Herausgeber; Ubuntu 24.04/26.04, Debian 12/13; live gelesen.
      - `download_image`: download-url in den Inhalt import, Prüfsumme prüft Proxmox.
      - `create_template`.
      - `provision_vm`: Benutzer alfred; Host-Schlüssel von Alfred per Snippet; Cloud-Init danach abgeschaltet; Fernzugang, CMDB und Käfig-Selbsttest automatisch.
      - `delete_vm` und `delete_image`.
    - Die schreibenden Fabrik-Aktionen laufen nur im Change-Motor.
    - Beweis als Changes geplant, die Owner-Freigabe ist offen:
      - 4dc47fa3: Ubuntu-24.04-Vorlage und Wegwerf-VM probe-i5;
      - 733bbe87: Stilllegung von probe-i5.
    - Ubuntu statt Debian, weil die Zielarchitektur Ubuntu 24.04 vorsieht.
- **I6** Daten-Übertragung + Tresor (E4-D, E4-G) → Beweis Container-Migration unkritisch (E5.3).
- **I7** Netz-Aktionen nach Owner-Entscheidungen (E4-N).
- **I8** Windows-Analyse (E4-W lesend), dann Windows-Vorlage.
- **I9** Upgrade-Lauf (E5.4); danach kritische Dienste nach Owner-Freigabe.

## 7. Risiken

- **Lange Ketten mit realen Folgen:** gemildert durch festen Motor, Prüfung je Schritt, Sicherung vor Änderung, Freigabe pro Change, Rückweg.
- **Netz-Änderungen können Alfred selbst aussperren** (Firewall/DNS): Regel — Änderungen, die den Weg Alfred ↔ Host betreffen, enden mit einer Erreichbarkeitsprüfung und automatischem Rückweg nach Zeitlimit (wie „Bestätigen oder zurück in 5 min“ bei Routern).
- **Datenkonsistenz bei Datenbanken:** Dienst stoppen vor letzter Übertragung; Prüfsummen/Zeilenzahlen.
- **Geheimnisse:** nur Tresor-Verweise; Schwärzung (v1551) bleibt als zweite Linie.
- **Modellqualität:** Planung kann schwach sein → Prüfung beim Anlegen, Architektur-Vorlage mit Pflichtabschnitten, Owner-Freigabe; Ausführung modellunabhängig.
