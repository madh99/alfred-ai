# I8e Folge-Etappe — eigene Alfred-Logins für SQL Server auf Linux, danach `sa` abschalten

Stand 22.11.2026 · Vorhaben c7e02aff (I8e) · Folgeaufgabe aus Spec `2026-11-19-i8e-linux-sql-ad-tls.md` §9 (Punkte 1 und 2) · baut auf Etappe 3 auf (abgenommen 21.11.).

## 1. Zweck und Warum

Alfred meldet sich heute an allen drei Linux-Instanzen (sqllnx01, sqllnx02, sqllnxcfg) als `sa` an. Das Kennwort liegt im Tresor (`sqllnx-<zugang>-sa`). `sa` ist der bekannteste Angriffsname auf jedem SQL Server und hat volle Rechte. Außerdem läuft das Kennwort mit vollen Rechten auch bei rein lesenden Aufrufen über die Leitung, die regelmäßig ohne Change laufen: der Status für die Überwachung `linux-sql-ueberwachung` und Prüfungen in Changes.

Ziel ist es, `sa` abzuschalten. Dafür bekommt Alfred **zwei eigene Logins**, getrennt nach Zweck (Owner 22.11.: „wie empfohlen“):
- `alfred_admin`: sysadmin, nur für ändernde Bausteine.
- `alfred_status`: nur Leserecht, für lesende Bausteine und die Überwachung.

## 2. Ziele

1. Auf jeder der drei Instanzen gibt es `alfred_admin` (sysadmin) und `alfred_status` (nur lesen) als SQL-Logins. Das Kennwort erzeugt Alfred selbst und legt es nur im Tresor ab.
2. Jeder ändernde Baustein von `linux_sql` und `linux_ha` meldet sich als `alfred_admin` an. Jeder lesende Baustein (`linux_sql status` und Prüfungen) meldet sich als `alfred_status` an.
3. `sa` ist auf allen drei Instanzen abgeschaltet (`ALTER LOGIN sa DISABLE`). Danach ist belegt, dass alle Bausteine weiterlaufen, einschließlich Failover hin und zurück und einer LOG-Sicherung.
4. Es gibt einen **belegten Notfallweg** für den Owner, falls Alfreds Logins oder Kennwörter verloren gehen. Er ist vor dem Abschalten auf einer Instanz live bewiesen.
5. Neue Installationen folgen demselben Weg: `installieren` legt die beiden Logins an. Für spätere Instanzen bleibt nichts offen.

## 3. Nicht-Ziele

- SQL Server unter Windows (sql01/sql02): Dort meldet sich Alfred über Windows an, nicht über `sa`.
- Automatischer Kennwortwechsel der Alfred-Logins. Ein späterer Standard-Change ist möglich, ist aber nicht Teil dieser Etappe.
- AD- oder Kerberos-Anmeldung für Alfred. Abgelehnt, weil sqllnxcfg nicht in der Domäne ist und Alfred bei einem Ausfall der DCs keinen Failover mehr steuern könnte.
- Pacemaker-Login `alfred_pacemaker`: Es bleibt unverändert, weil es schon eingeschränkt ist.
- M-2 (R9): Das bleibt eine eigene Nachholaufgabe.

## 4. Anti-Ziele (ein Fehlschlag, auch wenn es technisch läuft)

- Alfred fällt still auf `sa` zurück, wenn das eigene Login scheitert.
- `alfred_status` hat in Wahrheit mehr als Leserechte, zum Beispiel über eine Rolle oder einen vergessenen Grant.
- `sa` wird abgeschaltet, bevor der Notfallweg bewiesen ist, oder bevor alle Bausteine nachweislich ohne `sa` laufen.
- Ein Kennwort erscheint in einer Befehlszeile, einer Ausgabe, im Log oder im Change-Ergebnis.
- Das Abschalten betrifft die AG-Funktion (Failover, Synchronisation, Pacemaker-Monitor).

## 5. Rahmenbedingungen (belegt)

- Heute meldet sich jeder T-SQL-Baustein in `linux-sql.ts` über `sqlcmd_sa()` an: Das Kennwort steht in `SQLCMDPASSWORD`, T-SQL kommt über stdin, `-x`. Der Status in Python meldet sich ebenfalls als `-U sa` an. `linux-ha-skill.ts` liest `saName(z)` für alle Zugänge (Zeilen 376 und 667).
- Die Tresor-Namen bildet `saName()` bzw. `loginTresorName()` (`sqllnx-<zugang>-<login>`, höchstens 61 Zeichen). `login_anlegen` legt heute schon SQL-Logins mit Tresor-Kennwort an und lehnt `sa` als Namen ab.
- Lesend und ändernd sind fest getrennt: `aktionsArt` in `change-schritte.ts`. Bei linux_sql sind nur `status` und `sicherungen` lesend.
- Welche lesenden Bausteine heute `sa` nutzen, ist geprüft (Builder-Prüfung 22.11.):
  - Nur `linux_sql status` meldet sich als `sa` an.
  - `linux_sql sicherungen` übergibt kein SQL-Kennwort. Sein Sicherungsteil auf dem Host nutzt die Pacemaker-Zugangsdatei (`linux-sql-skill.ts:1030`, `linux-sql-sicherung.ts:1390–1422`).
  - `linux_ha status` meldet sich schon als `alfred_pacemaker` an (`linux-ha.ts:1826–1844`).
  - Bei `linux_ha` lesen nur die ändernden AG-Bausteine `sa` (`linux-ha-skill.ts:667`).
- `status` macht heute weich weiter: Ohne Kennwort zeigt er nur die Betriebssystem-Sicht. Bei einem Anmeldefehler liefert er `sqlFehler` und trotzdem `success: true` (`linux-sql.ts:1131–1153`). Die Überwachung erzeugt Befunde nur zu TLS und Keytab.
- Die Agent-Jobs der Sicherung gehören `sa` (`@owner_login_name = N'sa'`, `linux-sql-sicherung.ts:306`).
- `installieren` prüft sich selbst mit einer Anmeldung als `sa`. Mehrere Aktionen prüfen vorab den `sa`-Tresornamen (`linux-sql-skill.ts:567, 581–583`).
- `linux_ha` hat heute keinen Baustein, der einen Knoten in Standby setzt.
- Der Owner hat schon heute einen zweiten sysadmin-Weg an sqllnx01 und sqllnx02: AD-Gruppe `SQL-Linux-Admins` (Login per `ad_login`, Kerberos, Etappe 3). An sqllnxcfg gibt es keine AD-Logins.
- Microsoft dokumentiert für Linux das Zurücksetzen des `sa`-Kennworts mit `systemctl stop mssql-server` und `mssql-conf set-sa-password` (bzw. `setup`). **Nicht dokumentiert ist, ob das ein abgeschaltetes `sa` wieder einschaltet.** Das wird bewiesen, nicht angenommen (Ziel 4).
- TLS ist erzwungen. Alle Verbindungen laufen mit Zertifikatsprüfung (Etappe 3).

## 6. Bauweg — Entscheidung

- **A — ein Login `alfred_admin` ersetzt `sa` überall.** Wenig Umbau. Der Name `sa` fällt weg. Das Kennwort mit vollen Rechten läuft aber weiter bei jedem Statusaufruf über die Leitung.
- **B — zwei Logins, Zweck gebunden an `aktionsArt`** *(gewählt, Owner 22.11.)*. Ändernde Bausteine nutzen `alfred_admin`, lesende `alfred_status`. Der Umbau ist etwas größer: zwei Anmeldewege in Bash und Python, Rechte-Prüfung für `alfred_status`. Dafür liegt im Alltag nur ein Lese-Kennwort auf der Leitung.
- **C — AD-Konto mit Keytab.** Verworfen, siehe Nicht-Ziele.

## 7. Entwurf

### 7.1 Logins und Rechte

- `alfred_admin`: SQL-Login, Mitglied von `sysadmin`, `CHECK_POLICY = ON`, `CHECK_EXPIRATION = OFF`. Tresor: `sqllnx-<zugang>-alfred-admin`.
- `alfred_status`: SQL-Login ohne Serverrolle. Es bekommt nur die Rechte, die der Status und die Prüfungen nachweislich brauchen: Server-Zustand, Datenbank- und Dateikatalog, Sicherungshistorie in `msdb`. Tresor: `sqllnx-<zugang>-alfred-status`.
- Beide Kennwörter erzeugt der Skill einmalig, genau wie heute bei `login_anlegen` (nie still ersetzen). Gibt es ein Login schon, aber das Kennwort nicht im Tresor, bricht der Skill ohne Änderung ab.

### 7.2 Anmeldung in den Bausteinen

- Die Wahl des Logins folgt **fest** der `aktionsArt` des Bausteins: `aendern` → `alfred_admin`, `lesen` → `alfred_status`. Die Wahl hängt nicht vom Modell und nicht von der Eingabe ab.
- **Umstellung je Zugang, beide Logins gemeinsam:** Sobald für einen Zugang **einer** der Tresor-Einträge `…-alfred-admin` oder `…-alfred-status` existiert, gilt der Zugang als umgestellt. Dann sind **beide** Einträge Pflicht, und `sa` wird für diesen Zugang nie mehr benutzt. Fehlt ein Eintrag oder scheitert die Anmeldung, bricht der Skill sichtbar ab und nennt das Login. Es gibt keinen Rückfall auf `sa`. Nur wenn beide Einträge fehlen, gilt weiter `sa` (Übergang).
- **Dauerhafte Sperre:** `sa_schalten an=false` schreibt zusätzlich eine Marke auf den Host (root, 0644, ohne Geheimnis). Liegt die Marke vor, lehnt der Skill jede Anmeldung als `sa` ab, auch wenn die Tresor-Einträge fehlen. Nur `sa_schalten an=true` entfernt die Marke. Ein versehentlich gelöschter Tresor-Eintrag führt damit zum Abbruch, nicht zurück zu `sa`.
- **Alle Vorprüfungen und Selbstprüfungen**, die heute den `sa`-Tresornamen verlangen oder sich als `sa` anmelden, folgen derselben Wahl. Das gilt ausdrücklich auch für `installieren`: Ein erneuter Lauf auf einer umgestellten Instanz mit abgeschaltetem `sa` meldet „nichts zu tun“ und prüft sich als `alfred_admin`.
- Jedes Ergebnis nennt das verwendete Login (zum Beispiel „angemeldet als alfred_admin“). Damit ist die Umstellung im Change-Ergebnis belegbar.
- Kennwörter kommen weiter nur als JSON in der ersten stdin-Zeile und gehen nur in `SQLCMDPASSWORD` des einen Prozesses.

### 7.3 Neue Aktionen (nur im Change)

- `linux_sql alfred_logins_anlegen`: legt beide Logins an (Anmeldung als `sa`) und erzeugt die Kennwörter im Tresor. Selbstprüfung: Anmeldung als jedes der beiden Logins. `alfred_admin` ist sysadmin, `alfred_status` ist es nicht, und ein Schreibversuch als `alfred_status` wird abgewiesen. Rückweg: `alfred_logins_entfernen`, nur solange `sa` aktiv ist.
- `linux_sql sa_schalten an=false|true`: schaltet `sa` ab bzw. wieder ein (Anmeldung als `alfred_admin`). Fail-closed: Abschalten nur, wenn die Anmeldung als `alfred_admin` mit sysadmin im selben Lauf gelungen ist. Selbstprüfung: `is_disabled` aus `sys.server_principals`. Rückweg: `an=true`.
- Status: Die Statusanzeige nennt den Zustand von `sa` (aktiv/aus) und die vorhandenen Alfred-Logins, mit festem Wortlaut in `FESTE_AUSGABEN`.
- **Gescheiterte Status-Anmeldung:** `status` bleibt für den Betriebssystem-Teil lesbar, meldet aber einen festen Text „SQL-Anmeldung als alfred_status gescheitert“. Die Überwachung `linux-sql-ueberwachung` macht daraus einen **Befund hoch**, denn unlesbar heißt nicht ok. Das gilt für jeden umgestellten Zugang.
- `linux_sql sa_kennwort_setzen` (Notfallweg als Baustein, nur im Change): führt den dokumentierten Weg aus. Das sind `systemctl stop mssql-server`, `mssql-conf set-sa-password` mit dem **vorhandenen** Kennwort aus `sqllnx-<zugang>-sa` (über die Umgebung des einen Prozesses, nie in der Befehlszeile) und `systemctl start mssql-server`. Der Tresor ändert sich dabei nicht. Fehlt der Eintrag, bricht der Baustein ab. Selbstprüfung: Dienst aktiv und Anmeldung als `sa` gelingt.
- `linux_ha knoten_standby an=true|false` (neu, nur im Change): setzt einen Pacemaker-Knoten in Standby bzw. holt ihn zurück. Fail-closed: Für einen Replikat-Knoten nur, wenn er sekundär ist. Selbstprüfung über `crm_mon`. Rückweg: `an=false`.
- **Agent-Jobs** bleiben im Besitz von `sa` (meine Wahl). Ein Job eines abgeschalteten sysadmin-Logins läuft weiter unter dem Agent-Dienst. Ein Umzug auf `alfred_admin` würde die Sicherung von Alfreds Login abhängig machen. Bewiesen wird das mit einem **geplanten** Agent-Lauf nach dem Abschalten (Abschnitt 8).

### 7.4 Notfallweg (Owner)

- Für sqllnx01 und sqllnx02: Anmeldung als Mitglied von `SQL-Linux-Admins` (Kerberos, SSMS auf sqladmw11/sqladm25). Ein Mitglied ist sysadmin und kann `sa` einschalten oder Alfreds Kennwörter neu setzen.
- Für alle drei Instanzen, auch sqllnxcfg: `linux_sql sa_kennwort_setzen` (Alfred) oder dieselben drei Befehle von Hand auf dem Host. Der Knoten steht dabei in Pacemaker-Standby, damit Pacemaker den gestoppten Dienst nicht als Fehler wertet oder fenct. Ob das ein abgeschaltetes `sa` wieder nutzbar macht, wird **auf sqllnxcfg** live bewiesen (Change N2). Ist es nicht der Fall, bricht N2 ab, und der Weg über den Einzelbenutzermodus (`sqlservr -m`) wird erst entworfen und belegt, bevor N3 kommt.
- Der bewiesene Weg kommt wörtlich in diese Spec (Abschnitt 10) und in die Doku des Vorhabens.

### 7.5 Reihenfolge der Changes

1. **Release** mit 7.1–7.3 (Code, Tests).
2. **Change N1 — Logins anlegen:** `alfred_logins_anlegen` auf sqllnxcfg, sqllnx02 und sqllnx01. Danach je Instanz ein `linux_sql status` (als `alfred_status`) und ein harmloser ändernder Probe-Baustein (als `alfred_admin`), damit beide Wege belegt sind. `sa` bleibt in diesem Change aktiv.
3. **Change N2 — Notfallweg-Beweis auf sqllnxcfg:**
   - `knoten_standby an=true` für sqllnxcfg. Beleg: Die AG bleibt auf sqllnx01/02 synchron, und das Quorum steht (Konfigurationsreplikat aus, zwei synchrone Replikate, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT=0).
   - `sa_schalten an=false`.
   - `sa_kennwort_setzen`. Beleg: Die Anmeldung als `sa` gelingt wieder, `is_disabled` ist 0.
   - Danach `sa_schalten an=false` und `knoten_standby an=false`.
   - Abschluss: Pacemaker ohne Fehlerzähler, Cluster 3/3, AG synchron.
4. **Change N3 — `sa` abschalten auf sqllnx02, dann sqllnx01.** Danach der Betriebsbeweis: alle Bausteine laufen weiter (Abschnitt 8).

## 8. Beweis (Abnahme)

- An allen drei Instanzen: `sa` ist abgeschaltet (`is_disabled = 1`), eine Anmeldung als `sa` wird abgewiesen.
- `linux_sql status` läuft als `alfred_status`. Ein Schreibversuch als `alfred_status` wird abgewiesen.
- Mit abgeschaltetem `sa`:
  - Failover hin und zurück über `linux_ha` ohne Pacemaker-Monitorfehler.
  - Ein **geplanter** LOG-Lauf des Agent-Jobs (nicht `sicherung_jetzt`) mit fs01-Kopie, damit die Job-Eigentümerschaft belegt ist.
  - Die Überwachung `linux-sql-ueberwachung` ohne neuen Befund.
  - Ein erneuter `installieren`-Lauf meldet „nichts zu tun“.
- Sperre: Mit gesetzter Marke und testweise fehlendem Tresor-Eintrag bricht der Skill ab (Test, nicht live).
- Der Notfallweg ist auf sqllnxcfg belegt (Change N2).
- In keinem Change-Ergebnis und keinem Log steht ein Kennwort. Geprüft wird mit grep nach den Tresor-Werten, serverseitig, ohne Ausgabe der Werte.

## 9. Dem Builder überlassen

- Der genaue Rechtesatz von `alfred_status`. Er muss gegen die tatsächlichen Abfragen von `status` (Bash und Python) bewiesen sein, mit einem Test, der jede Abfrage einer Rechte-Anforderung zuordnet. Der Grundsatz ist „so wenig wie möglich“.
- Ob `alfred_logins_anlegen` eine eigene Aktion wird oder eine Erweiterung von `login_anlegen` mit festen Namen.
- Welcher harmlose ändernde Probe-Baustein in N1 dient.
- Wo `installieren` die Logins anlegt (Ziel 5), vorausgesetzt, die bestehende Marke ALFRED-SA-GESETZT bleibt wirksam.

## 9a. Klärungen nach der Builder-Prüfung (22.11., meine Wahl)

- N2 läuft als Alfred-Change mit zwei neuen Bausteinen (`knoten_standby`, `sa_kennwort_setzen`), nicht als Handgriff. Der Baustein ist zugleich der Notfallweg und damit wiederholbar.
- `sa_kennwort_setzen` setzt das **vorhandene** Tresor-Kennwort, es ersetzt nichts.
- Eine gescheiterte Status-Anmeldung wird ein Befund hoch und kein harter Abbruch von `status`. Die Betriebssystem-Sicht bleibt lesbar.
- Agent-Jobs bleiben bei `sa`. Der Beweis ist ein geplanter Lauf.
- Die Sperre gilt je Zugang, für beide Logins gemeinsam, plus Host-Marke.
- `installieren` folgt der Login-Wahl.
- Spec-Korrektur: `sicherungen` und `linux_ha status` brauchen keine Umstellung.

## 10. Notfallweg (wird nach Change N2 eingetragen)

*Leer bis zum Beweis.*
