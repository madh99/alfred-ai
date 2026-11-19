# I8e Etappe 3 — AD-Anmeldung (Kerberos) und PKI-TLS für SQL Server auf Linux

Stand 19.11.2026 · Vorhaben c7e02aff (I8e) · baut auf I8c (AD `ad.3033.at`, dc01/dc02), PKI-Etappen 1–4 (pkiiss01, SQL-TLS unter Windows erzwungen v1857) und I8e Paket 1+2 (sqllnx01/02/sqllnxcfg, AG `sqllnxag01`, VIP 10.203.30.13) auf.

## 1. Zweck und Warum

Die Linux-SQL-Instanzen sollen dasselbe Sicherheitsniveau wie sql01/sql02 unter Windows bekommen: Anmeldung über das AD statt über SQL-Kennwörter und verschlüsselte Verbindungen mit einem Zertifikat der eigenen PKI. Die Spec §I8e sieht AD-Anmeldung (Keytab) ausdrücklich vor, sobald I8c steht. Diese Etappe holt das nach.

Nutzer (Owner 19.11.): **Admins mit SSMS, Anwendungen und Alfred selbst.**

## 2. Ziele

1. **Kerberos-Anmeldung** an sqllnx01, sqllnx02 und über den Listener `sqllnxag01`, auch nach einem Failover.
2. **AD-Gruppen als Logins:** `AD3033\SQL-Linux-Admins` → sysadmin; je Anwendung eine Gruppe `SQL-Linux-<App>` mit Rechten je Datenbank. Wer darf, entscheidet die Gruppenmitgliedschaft im AD.
3. **Anwendungen** melden sich mit eigenem AD-Dienstkonto an; nur Anwendungen auf Nicht-Domänen-Rechnern bekommen ausnahmsweise ein SQL-Login mit Kennwort im Tresor.
4. **TLS erzwungen** (`forceencryption`), nur TLS 1.2/1.3, Zertifikat aus pkiiss01 (RSA 3072), Name des Hosts, Kurzname und Listener im Zertifikat.
5. **Alfred prüft das Zertifikat** bei seinen eigenen Verbindungen (heute `sqlcmd -C` = Zertifikat ungeprüft).
6. **Erneuerung** von Zertifikat und Keytab als wiederholbarer Change mit Ablaufwarnung.
7. **Feste Systemprüfung in der Planprüfung:** Ein Change, der eine Windows-Aktion auf einem Linux-Zugang (oder umgekehrt) plant, wird abgelehnt — unabhängig vom Modell (Owner 19.11.: „ist sichergestellt, dass Alfred Windows und Linux richtig behandelt?“).

## 3. Nicht-Ziele

- `sa` abschalten — bleibt in dieser Etappe (Owner 19.11.), ist aber **feste Folgeaufgabe** (Abschnitt 9), kein „offen“.
- Eigenes Login für Alfred statt `sa` — ebenfalls Folgeaufgabe (berührt alle bestehenden Bausteine).
- Automatische Zertifikatserneuerung aus Linux heraus (certmonger/cepces gegen AD CS) — zusätzlicher Webdienst auf der PKI, zu viel Angriffsfläche für drei Server.
- Windows-Authentifizierung für den AG-Endpunkt — unter Linux nur `CERTIFICATE` unterstützt; der Endpunkt bleibt wie in Paket 2.
- NTLM — unter Linux für Fernverbindungen nicht unterstützt; nur Kerberos.

## 4. Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- AD-Admin-Anmeldedaten auf einem Linux-Host (auch nicht kurzzeitig im Speicher eines Linux-Prozesses).
- Privater TLS-Schlüssel verlässt den Linux-Host oder liegt im Tresor/Log.
- Keytab-Datei wird zwischen Hosts kopiert oder liegt lesbar für andere als `mssql`/root.
- Ein Failover, nach dem Kerberos über den Listener nicht mehr geht (SPN falsch zugeordnet) — muss im Beweis vorkommen.
- Pacemaker (Ressourcen-Agent `ocf:mssql:ag`) kann nach `forceencryption` nicht mehr überwachen → Fehl-Failover. Muss vor dem Erzwingen geprüft und im Failover-Beweis belegt sein.
- Etwas ändert sich still: jede Aktion meldet, was sie getan hat, prüft sich selbst und bricht bei Unlesbarem ab (fail-closed).

## 5. Rahmenbedingungen (belegt)

- **Domänenbeitritt ist der vorgesehene Weg** (Microsoft: realmd/sssd, „preferred method“). SQL Server braucht sssd/NSS für die SID-Zuordnung von AD-Benutzern und -Gruppen. `network.disablesssd` (nur LDAP) ist der Sonderweg und wird nicht genutzt.
- **Reverse-DNS** für die Linux-Hosts ist Voraussetzung (Microsoft); PTR-Einträge für DCs ebenso.
- **gMSA wird unter Linux nicht unterstützt;** Microsoft beschreibt nur ein normales AD-Benutzerkonto plus Keytab. Das Konto ist kein Dienst-Anmeldekonto, nur Träger von SPN und Schlüssel (SQL läuft als lokaler Benutzer `mssql`).
- **Keytab-Wechsel:** `mssql-conf setup-ad-keytab … --use-next-kvno` oder neue kvno; danach Neustart von SQL Server.
- **mssql-conf:** `network.kerberoskeytabfile`, `network.privilegedadaccount`, `network.tlscert`, `network.tlskey`, `network.tlsprotocols`, `network.forceencryption`. Alle wirken erst nach Neustart.
- **Netz:** VLAN 830 (SQL) → VLAN 829 (AD): Kerberos 88 TCP/UDP, kpasswd 464, LDAP 389, LDAPS 636, Global Catalog 3268, DNS 53. Ob die UniFi-Zonen das heute erlauben, ist zu prüfen (I8c-Lehre: Zone→Gateway verwarf DNS-Antworten).
- **Fenster/Neustarts:** Jede Änderung, die einen SQL-Neustart braucht, läuft rollierend: zuerst Sekundär, dann geplantes Failover (`linux_ha ag_failover`), dann der bisherige Primär, zum Schluss zurück. Kein gleichzeitiger Neustart beider Replikate.
- Bestehende Regeln: Changes mit Selbstprüfung und Rückweg, Prüfungen als eigene lesende Aktion, `erwartet` nur aus FESTE_AUSGABEN, keine Geheimnisse in Parametern/Ergebnissen (nur stdin), DCs ohne Snapshots.

## 6. Bauweg — Entscheidung

Betrachtet:

- **A — Feste Bausteine in den vorhandenen Skills, gesteuert über Changes** *(gewählt, Owner 19.11.)*. AD-Änderungen laufen auf den DCs über `windows_ad`, Zertifikatsausstellung auf pkiiss01 über `windows_pki`, alles auf dem Linux-Host über `linux_sql`. Jede Aktion wiederholbar, mit Selbstprüfung und Rückweg. Kosten: am meisten Code (3–4 Releases); dafür ist die spätere Erneuerung ein Standard-Change.
- **B — Microsofts `adutil` auf dem Linux-Host** legt Konto, SPN und Keytab an. Spart Windows-Bausteine, verlangt aber eine Domänen-Admin-Anmeldung (kinit) auf jedem Linux-Host → Admin-Anmeldedaten auf Nicht-DCs, plus ein zusätzliches Paket. Verworfen (Anti-Ziel).
- **C — Einzelbefehle über `fernzugriff.ausfuehren`** in einem großen Change. Am schnellsten, aber ohne Selbstprüfung, nicht wiederholbar, Halt mitten in Shell-Befehlen. Verworfen (widerspricht fail-closed / nichts still).

## 7. Entwurf

### 7.1 AD-Seite (`windows_ad`, läuft auf dc01)

- **Dienstkonto `svc-sqllnx`** (eines für alle drei Instanzen — der Listener-SPN darf nur einem Konto gehören und muss auf beiden Replikaten derselbe sein). Härtung: Zufallskennwort nur im Tresor (`ad-svc-sqllnx`), `msDS-SupportedEncryptionTypes` = AES128+AES256, „Konto ist vertraulich und kann nicht delegiert werden“, Anmeldung lokal/RDP verweigert (GPO-Recht oder `userWorkstations`), Kennwort läuft nicht ab (Wechsel nur per Change). Erweiterung des bestehenden `dienstkonto_anlegen` um diese Flags oder eigene Aktion — Builder entscheidet, Selbstprüfung liest alle Flags zurück.
- **SPNs** auf `svc-sqllnx`: `MSSQLSvc/<fqdn>:1433` und `MSSQLSvc/<fqdn>` für sqllnx01, sqllnx02, sqllnxag01 (Listener). Neue Aktionen `spn_setzen` / `spn_entfernen`; Selbstprüfung: jeder SPN genau einmal im Wald (`setspn -Q`), keine Dubletten.
- **DNS:** A- und PTR-Einträge für sqllnx01/02/sqllnxcfg und sqllnxag01 in `ad.3033.at` bzw. der Reverse-Zone des SQL-Netzes (Zone anlegen, falls fehlt). Vorhandenes `dns_eintrag` um PTR/Reverse-Zone erweitern.
- **Gruppen:** `SQL-Linux-Admins` (OU Gruppen), Anwendungsgruppen bei Bedarf. Vorhandene Struktur aus `grundstruktur` nutzen.
- **Privilegiertes Konto für LDAP-Abfragen** (`network.privilegedadaccount`): `svc-sqllnx` selbst (wie in Microsofts Anleitung) — keine zusätzlichen Rechte nötig (Lesen im AD).
- Computerkonten der Linux-Hosts entstehen durch den Beitritt in der **OU Server**; die vorab angelegten Konten (Pre-Staging) mit Beitrittsrecht für einen eng begrenzten Beitritts-Weg — siehe 7.3.

### 7.2 PKI-Seite (`windows_pki`, läuft auf pkiiss01)

- **Eigene Vorlage `AD3033-SQL-TLS-Linux-v1`** *(meine Wahl)*: wie die Windows-Vorlage (nur ServerAuthentication, RSA ≥ 3072, Name aus der Anforderung nur mit CA-Freigabe/Manager-Genehmigung, 365 Tage, Erneuerung 8 Wochen vorher), aber **ohne** CSP-/KeySpec-/„nicht exportierbar“-Vorgaben — die gelten für Windows-Schlüsselspeicher; unter Linux liegt der Schlüssel als Datei auf dem Host. Registrieren darf nur ein enges Anforderungskonto auf pkiiss01, nicht die Linux-Hosts.
- **Neue Aktion `fremd_csr_ausstellen`**: nimmt eine PEM-Anforderung (über stdin, kein Geheimnis), prüft sie **vor** dem Einreichen gegen die Allowlist (Subject CN, genau die erwarteten SANs, RSA ≥ 3072, SHA-256-Prüfsumme gleich der vom Linux-Host gemeldeten), reicht sie mit der Linux-Vorlage ein, genehmigt sie (bisheriger Genehmigungsweg mit Allowlist) und gibt Zertifikat + Kette (PEM) zurück. Ergebnis-Marke z. B. `SQL_TLS_LINUX_ISSUED`.
- Root- und Issuer-Zertifikat liefert die bestehende PKI-Veröffentlichung (fs01 HTTP/AD) — für den Vertrauensspeicher der Linux-Hosts.

### 7.3 Linux-Seite (`linux_sql`, neue Aktionen, nur im Change)

1. **`ad_beitreten`** — Pakete `realmd sssd sssd-tools adcli krb5-user libnss-sss libpam-sss` (feste Versionen wie in Paket 1/2, `hold`), Hostname als FQDN, DNS-Auflösung `ad.3033.at` und Reverse-DNS prüfen, Uhrzeit (chrony gegen die DCs, Kerberos verträgt ≤ 5 min), Beitritt. **Ohne Domänen-Admin auf dem Host:** Computerkonto wird vorher auf dc01 angelegt (`windows_ad`), der Beitritt nutzt ein **Einmal-Kennwort** für dieses Konto (`adcli join --one-time-password` bzw. `realm join --one-time-password`), das Alfred auf dem DC setzt und per stdin übergibt. Danach gilt das Einmal-Kennwort nicht mehr. Selbstprüfung: `realm list` zeigt die Domäne, `id svc-sqllnx@ad.3033.at` und eine Gruppenauflösung gehen, Computerkonto in OU Server. Rückweg `ad_verlassen` (Computerkonto deaktivieren bleibt `windows_ad`). sssd ohne Anmeldung von Domänenbenutzern am Host (`access_provider = simple`, leere Erlaubnisliste) — der Beitritt dient nur SQL Server, nicht der SSH-Anmeldung.
2. **`kerberos_einrichten`** — Keytab **auf dem Host** aus dem Kennwort von `svc-sqllnx` (stdin, `ktutil`, AES-Schlüssel, kvno aus dem AD gelesen), Eigentümer `mssql`, Rechte 0400, Pfad fest (`/var/opt/mssql/secrets/mssql.keytab`); `mssql-conf set network.kerberoskeytabfile`, `network.privilegedadaccount svc-sqllnx`. Neustart rollierend (7.5). Selbstprüfung: `klist -k` zeigt alle erwarteten SPNs mit der aktuellen kvno; `kinit -k` mit dem Keytab gelingt; nach Neustart meldet SQL keinen Keytab-Fehler im Errorlog.
3. **`tls_einrichten`** — Schlüssel RSA 3072 und Anforderung **auf dem Host** (`openssl`), Schlüssel 0400 `mssql`, nie im Ergebnis; Ergebnis nennt nur CSR (PEM, öffentlich) und SHA-256. Zweiter Aufruf (oder Teilaktion) nimmt das ausgestellte Zertifikat + Kette entgegen, prüft: passt zum Schlüssel, Kette bis zur Root, SANs genau wie verlangt, Laufzeit; setzt `network.tlscert`, `network.tlskey`, `network.tlsprotocols 1.2,1.3`, **zunächst ohne** `forceencryption`. Root und Issuer in `/usr/local/share/ca-certificates` + `update-ca-certificates`.
4. **`tls_erzwingen`** — eigener Schritt erst nach bestandener Prüfung, dass Pacemaker und Alfred mit TLS-Prüfung verbinden: `network.forceencryption 1`, Neustart rollierend. Rückweg `tls_erzwingen` aus.
5. **`ad_login`** — `CREATE LOGIN [AD3033\<Gruppe>] FROM WINDOWS` + Serverrolle bzw. Datenbankrolle; Selbstprüfung über `sys.server_principals`/`IS_SRVROLEMEMBER`; in der AG auf beiden Replikaten (Logins sind instanzbezogen).
6. **`status`** wird erweitert (fester Wortlaut, Stücke in FESTE_AUSGABEN): Domäne beigetreten ja/nein, Keytab (kvno, SPN-Zahl), TLS (Zertifikat-Thumbprint, gültig bis, erzwungen ja/nein), Ablaufwarnung (≤ 30 T mittel, ≤ 7 T hoch → Befund wie Windows-Überwachung).

### 7.4 Alfreds eigene Verbindung

- Alle `linux_sql`-/`linux_ha`-Bausteine verbinden künftig mit **Zertifikatsprüfung**: `sqlcmd -N` (verschlüsseln) ohne `-C`, Servername = **FQDN des Hosts** (nicht `localhost`, sonst passt der Name nicht zum Zertifikat; Auflösung über DNS bzw. hosts-Block aus Paket 2). Umstellung schaltbar je Zugang erst, wenn `tls_einrichten` bestanden hat (sonst bricht jeder Baustein) — der Schalter steht im Status und wird nie still zurückgesetzt.
- `sa` bleibt, nur lokal von Alfred genutzt (Abschnitt 9).

### 7.5 Reihenfolge der Changes (Vorschlag)

1. **Netz + DNS:** UniFi-Freigaben 830→829 (falls fehlend), A/PTR-Einträge, Reverse-Zone. Beweis: Auflösung vorwärts/rückwärts von allen drei Hosts.
2. **AD-Objekte:** `svc-sqllnx` gehärtet, SPNs, Gruppen, vorbereitete Computerkonten.
3. **Beitritt** sqllnxcfg → sqllnx02 → sqllnx01 (Konfig-Knoten zuerst, kein SQL-Datenverkehr).
4. **Kerberos** rollierend (Sekundär, Failover, Primär, zurück) — Beweis auf dem Linux-Host: `kerberos_einrichten` holt echte Diensttickets für den eigenen SPN und den Listener-SPN (`kvno -k`), Status „Kerberos-Keytab … aktuell“. *Reihenfolge-Korrektur 19.11. (Ruling R23, Gesamtprüfung):* Der Client-Beweis über sql01 (`auth_scheme = KERBEROS`) gehört ans Ende von Schritt 5, weil die Probe das Server-Zertifikat prüft und das PKI-Zertifikat erst dort eingespielt ist.
5. **TLS ohne Zwang** (Zertifikate ausstellen und einspielen, rollierend), dann **Alfred auf Zertifikatsprüfung umstellen**, dann **Pacemaker-Prüfung** (Monitor-Läufe fehlerfrei mit TLS), dann **Kerberos-Beweis über sql01** auf beiden Hosts und über den Listener, nach Failover erneut. Voraussetzung: Host-Firewall lässt sql01 (10.203.30.2) auf 1433 zu (Ruling R22).
6. **TLS erzwingen** rollierend — frühestens 30 min nach dem letzten Neustart aus Schritt 5 (Ruling R24, Pacemaker-Fenster), je Knoten erst erzwingen, dann neu starten (Neustart = `systemctl restart mssql-server` mit Prüfung Dienst aktiv / AG synchron). Beweis: Verbindung ohne Verschlüsselung wird abgelehnt; `encrypt_option = TRUE` für alle Sitzungen in `sys.dm_exec_connections`; Failover hin/zurück mit Pacemaker fehlerfrei (Torbeweis R18); eine LOG-Sicherung unter Zwang.
7. **Logins** für `SQL-Linux-Admins` auf beiden Replikaten; Owner-Test mit SSMS über `sqllnxag01`.

### 7.6 Feste Systemprüfung in der Planprüfung

- Jede Skill-Aktion, die auf einem Fernzugang läuft, erklärt ihr **Zielsystem** (`linux` | `windows`) — als Tabelle in `change-schritte.ts` (z. B. `linux_sql.*`, `linux_ha.*` → linux; `windows_ad.*`, `windows_pki.*`, `windows_cluster.*` → windows).
- Der Plan-Kontext kennt heute nur die Namen der Zugänge (`ctx.zugaenge`, Set); er bekommt zusätzlich das System je Zugang.
- `pruefeChangePlan` lehnt jeden Schritt (Aktion, Prüfung **und** Rückweg) ab, dessen Zugang das falsche System hat, mit einer Meldung, die den richtigen Weg nennt (z. B. „sqllnx01 ist Linux — Zertifikat über linux_sql tls_einrichten“).
- Zusätzlich prüft jede Aktion zur Laufzeit selbst (zweite Linie), wie `fernzugriff` heute schon bei Windows-Pfaden.
- Gilt auch für Standard-Changes/Vorlagen (Erneuerungen).

### 7.7 Erneuerung

- **Zertifikat:** Ablauf im Status und in der Überwachung (Befund wie Windows: ≤ 30 T mittel, ≤ 7 T hoch). Erneuerung = derselbe Weg `tls_einrichten` (neuer Schlüssel) + Neustart rollierend, als Standard-Change-Vorlage.
- **Keytab:** Kennwortwechsel `svc-sqllnx` auf dc01 → `kerberos_einrichten` mit neuer kvno auf allen Hosts → Neustart rollierend; alte kvno bleibt bis zum Ende im Keytab (Microsoft: Einträge werden angehängt), damit laufende Tickets gültig bleiben. Turnus: jährlich (meine Wahl), Owner kann ändern.

## 8. Beweis (Abnahme)

- `SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id = @@SPID` = `KERBEROS` für eine AD-Anmeldung an sqllnx01, sqllnx02 und über `sqllnxag01`, vor und nach einem Failover.
- Mitglied von `SQL-Linux-Admins` ist sysadmin; Nichtmitglied wird abgewiesen.
- Verbindung ohne Verschlüsselung wird abgewiesen; mit Verschlüsselung und Zertifikatsprüfung (ohne „Trust Server Certificate“) gelingt von einem Domänenrechner aus.
- Alfreds Bausteine laufen mit Zertifikatsprüfung (kein `-C` mehr); ein Test mit falschem Namen schlägt fehl (Beleg, dass wirklich geprüft wird).
- Failover hin und zurück mit erzwungenem TLS: Pacemaker meldet keine Monitor-Fehler, Zeiten im Rahmen von Paket 2.
- Planprüfung lehnt einen absichtlich falsch geplanten Schritt (`windows_pki sql_tls_anfordern` auf sqllnx01) ab.

## 9. Feste Folgeaufgaben (nicht offen gelassen)

1. **Alfred bekommt ein eigenes Login** (AD-Konto mit Keytab auf den Hosts oder SQL-Login im Tresor — eigene Entscheidung), alle Bausteine stellen um.
2. **`sa` abschalten** (`ALTER LOGIN sa DISABLE`) — direkt nach 1., mit Beweis, dass alle Bausteine weiterlaufen.
3. M-2 aus Paket 2 (Grund ALFRED-ERZWUNGEN in der Job-Historie) bleibt nach Ruling R9 nachholbar.

## 10. Klärungen nach der Builder-Prüfung (19.11.)

- **sqllnxcfg** *(meine Wahl)*: bekommt **TLS-Zertifikat und `forceencryption`** wie die beiden Replikate (Pacemaker überwacht sie, Alfreds Bausteine verbinden dort ebenfalls mit Zertifikatsprüfung; Pacemaker-Beweis schließt sie ein). Sie bekommt **keinen Domänenbeitritt, keinen Keytab, keine SPNs und keine AD-Logins** — als Configuration-only-Replikat hält sie keine Datenbanken, an ihr meldet sich niemand an. „Für alle drei Instanzen“ in 7.1 heißt damit: `svc-sqllnx` gilt für sqllnx01, sqllnx02 und den Listener. Reihenfolge 7.5 Schritt 3 entsprechend nur sqllnx02 → sqllnx01.
- **Hostname bleibt kurz** *(aus den Rahmenbedingungen)*: `hostname` bleibt `sqllnx01`/`sqllnx02` — daran hängen Pacemaker-Knoten, hosts-Block aus Paket 2, `@@SERVERNAME` und die AG-Replikanamen. Nur `hostname -f` muss den FQDN liefern (hosts-Block/DNS), der Beitritt setzt den Computernamen ausdrücklich (`--computer-name`) statt ihn aus `hostname` abzuleiten. Kein Umbau des Hostnamens.
- **Anforderungskonto auf pkiiss01** *(meine Wahl)*: neues AD-Konto `svc-pki-linuxreq` (Kennwort im Tresor), Mitglied einer neuen Gruppe `PKI-SQL-TLS-Linux-Registrieren`, die **nur** auf `AD3033-SQL-TLS-Linux-v1` registrieren darf. `fremd_csr_ausstellen` reicht mit diesem Konto ein und prüft den Anforderer in der Genehmigung gegen genau dieses Konto. Die Linux-Hosts selbst dürfen nicht registrieren.
- **Systemprüfung (7.6) — Umfang** *(meine Wahl)*: gilt für alle Skill-Aktionen mit festem Zielsystem (`linux_*`, `windows_*` und künftige). **Systemneutrale** Schritte (`fernzugriff.lesen/ausfuehren`, Prüfungen `befehl`/`datei`) sind ausgenommen — dort wählt der Fernzugang heute schon je System den richtigen Weg (Windows-Leseliste/Käfig bzw. Linux-Käfig); eine Shell-Erkennung würde bestehende Changes und Vorlagen brechen.
- **UniFi-Freigaben 830→829**: setzt Alfred selbst als Change-Schritt mit den vorhandenen UniFi-Bausteinen (wie in I8c die DNS-Antwort-Policy); vorher lesender Erreichbarkeitsbeweis (Ports 88/389/464/636/3268/53 von jedem Linux-Host zu dc01/dc02), nur bei Lücke eine Policy.

- **Abnahme-Rechner (Owner 19.11.: beides):**
  1. **Automatisch über sql01:** Alfred führt `sqlcmd -E` (Kerberos, Zertifikatsprüfung, ohne „Trust Server Certificate“) als **geplante Aufgabe unter einem Test-Domänenkonto** `svc-sqllnx-test` aus (Mitglied `SQL-Linux-Admins`, Kennwort im Tresor) — die SSH-Schlüsselanmeldung hat unter Windows kein Netz-Kerberos (I8c-Lehre), die Aufgabe mit Konto-Anmeldung schon. Ergebnis (`auth_scheme`, `encrypt_option`, `@@SERVERNAME`) liest Alfred zurück. Dieser Weg ist der Abnahme-Beweis in Abschnitt 8 und bleibt als wiederholbare Prüfung (z. B. nach Erneuerungen).
  2. **Admin-Client mit SSMS** als eigenes Paket am Ende: Windows-Rechner in der Domäne für den Owner. Braucht eine Vorlage mit Oberfläche — Vorlage 9100 ist Server Core. Weg: die geplante **Windows-11-Vorlage** (steht in der I8-Reihenfolge ohnehin an) oder Server 2025 mit Desktop Experience; Entscheidung beim Planen dieses Pakets. Die Etappe gilt mit Beweis 1 als abgenommen; Paket 2 folgt und blockiert sie nicht.

## 11. Dem Builder überlassen

- Ob `svc-sqllnx`-Härtung als Erweiterung von `dienstkonto_anlegen` oder eigene Aktion.
- Genaue Paketversionen (fest gepinnt wie Paket 1/2), Pfade, Aufteilung von `tls_einrichten` in Anfordern/Einspielen.
- Ob die Systemprüfung als Tabelle oder als Eigenschaft der Skill-Metadaten umgesetzt wird (deterministisch muss sie sein).
- Wie der Ressourcen-Agent `ocf:mssql:ag` mit erzwungenem TLS verbindet (Treiber-Einstellungen) — **muss vor `tls_erzwingen` geklärt und belegt sein**.
