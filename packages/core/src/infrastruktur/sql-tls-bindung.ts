/**
 * PKI Etappe 4 — SQL-TLS-Aktivierung (Bau-Spec 252217f3 Pos. 21–25, Architektur f583a405 „SQL-Aktivierung und Abnahme“):
 *   - zertifikat_status (L): konfigurierte Bindung (Registry SuperSocketNetLib) UND tatsächlich geladenes Zertifikat (SQL-Fehlerprotokoll
 *     seit dem letzten Start) getrennt, ForceEncryption/ForceStrictEncryption, Neustart ausstehend, Zertifikatseignung.
 *   - zertifikat_binden (Ä): Zertifikat + ForceEncryption setzen, vorher alle Gates (LocalMachine\My, privater Schlüssel, Laufzeit,
 *     Serverauthentifizierung, eigener FQDN im SAN, Kette mit Online-Sperrprüfung, Engine-Konto darf den Schlüssel lesen). Kein Neustart.
 *     Der Zustand davor wird auf dem Knoten gemerkt; zertifikat_bindung_wiederherstellen stellt GENAU ihn wieder her (auch leer).
 *   - engine_neustart (Ä): nur auf einem gesunden, synchronisierten SEKUNDÄREN Replikat bei gesundem Primär und Quorum; wartet bis
 *     SECONDARY/CONNECTED/HEALTHY und alle lokalen AG-Datenbanken SYNCHRONIZED. Nie Failover, nie Primär-Neustart.
 *   - tls_testen (L): TDS-Prelogin-Probe holt das tatsächlich vorgelegte Zertifikat (Thumbprint, Name, Kette, Online-Sperrprüfung) und
 *     prüft mit einer unverschlüsselt angefragten Verbindung, ob der Server Verschlüsselung erzwingt; dazu echte Anmeldung als
 *     Domänenkonto mit Encrypt=True;TrustServerCertificate=False (Kerberos, Server, Rolle, encrypt_option).
 * Kein freies T-SQL; Werte werden geprüft und als JSON übergeben.
 */
import { kopf, psText, kontoAusdruck } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';
import { SQL_FN, INSTANZ_VOR, BEZEICHNER } from './sql-server.js';

const THUMB = /^[0-9A-F]{40}$/;
const FQDN = /^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}(\\[A-Za-z][A-Za-z0-9_]{0,15})?$/;
const HASH = /^[0-9a-f]{64}$/;

const skript = (p: unknown, zeilen: string[]) => [...kopf(p, false), ...INSTANZ_VOR, SQL_FN, ...TLS_VOR, ...zeilen].join('\n');

/** gemeinsame Funktionen: Netzwerk-Schlüssel der Instanz, Bindung lesen, geladenes Zertifikat, Zertifikats-Gates */
const TLS_VOR = [
  "$instId = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL' -ErrorAction SilentlyContinue).$inst",
  "if (-not $instId) { throw ('SQL-Instanz ' + $inst + ' nicht gefunden') }",
  "$nk = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instId + '\\MSSQLServer\\SuperSocketNetLib'",
  "$merkDir = Join-Path $env:ProgramData 'Alfred\\sql'; $merk = Join-Path $merkDir ('tls-vorher-' + $inst + '.json')",
  "function Bindung { $v = Get-ItemProperty -LiteralPath $nk; [ordered]@{ zertifikat = ([string]$v.Certificate).Trim().ToUpper(); force = [int]$v.ForceEncryption; strikt = $(if ($null -ne $v.ForceStrictEncryption -and [string]$v.ForceStrictEncryption -ne '') { [int]$v.ForceStrictEncryption } else { $null }) } }",
  "function BindungsHash($b) { $t = [string]$b.zertifikat + '|' + [string]$b.force + '|' + [string]$b.strikt; -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) }",
  // im aktuellen Fehlerprotokoll (seit dem letzten Start) die letzte Zeile „… loaded for encryption“
  "function Geladen { $f = [string](Sql \"SELECT CAST(SERVERPROPERTY('ErrorLogFileName') AS nvarchar(400)) f\")[0].f; $z = @(Get-Content -LiteralPath $f -Encoding Unicode -TotalCount 2000 -ErrorAction SilentlyContinue | Select-String -SimpleMatch 'loaded for encryption' | ForEach-Object { $_.Line }); if (-not $z.Count) { return [ordered]@{ art = 'unbekannt'; thumbprint = ''; zeile = '' } }; $l = [string]$z[-1]; if ($l -match 'Cert Hash\\(sha1\\) \"([0-9A-Fa-f]{40})\"') { return [ordered]@{ art = 'zertifikat'; thumbprint = $Matches[1].ToUpper(); zeile = $l } }; if ($l -match 'self-generated') { return [ordered]@{ art = 'selbsterzeugt'; thumbprint = ''; zeile = $l } }; [ordered]@{ art = 'unbekannt'; thumbprint = ''; zeile = $l } }",
  "function SqlStart { [datetime](Sql 'SELECT sqlserver_start_time t FROM sys.dm_os_sys_info')[0].t }",
  "function EngineKonto { [string](Get-CimInstance Win32_Service -Filter (\"Name='\" + $svc + \"'\")).StartName }",
  "function Fqdn { ($env:COMPUTERNAME + '.' + [string](Get-CimInstance Win32_ComputerSystem).Domain).ToLower() }",
  "function Sans($c) { $x = $c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }; if (-not $x) { return @() }; @(($x.Format($false) -split ',\\s*') | Where-Object { $_ -match '^(DNS Name|DNS-Name)=' } | ForEach-Object { ($_ -replace '^(DNS Name|DNS-Name)=', '').Trim().ToLower() }) }",
  // Gates für ein zu bindendes bzw. gebundenes Zertifikat: jede Zeile ein Grund
  "function ZertGruende([string]$tp, [string]$engine) {",
  "  $c = Get-Item ('Cert:\\LocalMachine\\My\\' + $tp) -ErrorAction SilentlyContinue",
  "  if (-not $c) { 'nicht in LocalMachine\\My'; return }",
  "  if (-not $c.HasPrivateKey) { 'ohne privaten Schlüssel' }",
  "  $jetzt = Get-Date; if ($c.NotBefore -gt $jetzt -or $c.NotAfter -le $jetzt) { 'Laufzeit ' + $c.NotBefore.ToString('s') + ' – ' + $c.NotAfter.ToString('s') + ' nicht gültig' }",
  "  $eku = @(($c.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }).EnhancedKeyUsages | ForEach-Object { $_.Value }); if ($eku -notcontains '1.3.6.1.5.5.7.3.1') { 'ohne Serverauthentifizierung (EKU ' + ($eku -join ',') + ')' }",
  "  $fq = Fqdn; if (@(Sans $c) -notcontains $fq) { 'eigener Name ' + $fq + ' nicht im SAN' }",
  "  $ch = New-Object Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode = 'Online'; $ch.ChainPolicy.RevocationFlag = 'EntireChain'; $ch.ChainPolicy.UrlRetrievalTimeout = New-TimeSpan -Seconds 30",
  "  if (-not $ch.Build($c)) { 'Kette/Sperrprüfung: ' + ((@($ch.ChainStatus | ForEach-Object { [string]$_.Status }) | Select-Object -Unique) -join ', ') }",
  "  try { $kn = $c.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName } catch { $kn = '' }",
  "  $kf = Join-Path $env:ProgramData ('Microsoft\\Crypto\\RSA\\MachineKeys\\' + $kn)",
  "  if (-not $kn -or -not (Test-Path -LiteralPath $kf)) { 'Schlüsseldatei nicht gefunden (nur Legacy-CSP unterstützt)'; return }",
  "  $sid = (New-Object Security.Principal.NTAccount $engine).Translate([Security.Principal.SecurityIdentifier])",
  "  $lesen = @((Get-Acl -LiteralPath $kf).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read })",
  "  if (-not $lesen.Count) { 'Engine-Konto ' + $engine + ' darf den Schlüssel nicht lesen' }",
  "}",
];

// ── Pos. 21 — Status (lesend) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SqlTlsStatus {
  rechner: string; instanz: string; konfiguriert: string; force: number; strikt: number | null; geladen: { art: string; thumbprint: string; zeile: string };
  start: string; engineKonto: string; neustartAusstehend: boolean; gemerkt: { zertifikat: string; force: number; zeit: string } | null; geaendert: string;
  zertifikat: { thumbprint: string; subjekt: string; bis: string; gruende: string[] } | null; bindungsHash: string;
}

export function sqlTlsStatusSkript(instanz?: string): string {
  return skript(instanz ? { instanz } : {}, [
    '$b = Bindung; $g = Geladen; $st = SqlStart; $engine = EngineKonto',
    "$m = $null; if (Test-Path -LiteralPath $merk) { $m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json }",
    "$geaendert = $(if ($m -and $m.geaendert) { [datetime]$m.geaendert } else { $null })",
    // ausstehend: konfiguriert ≠ geladen, oder Alfred hat nach dem letzten Start geändert (z. B. nur ForceEncryption)
    "$ausstehend = ($b.zertifikat -and $g.thumbprint -ne $b.zertifikat) -or (-not $b.zertifikat -and $g.art -eq 'zertifikat') -or ($geaendert -and $geaendert -gt $st)",
    "$z = $null; if ($b.zertifikat) { $c = Get-Item ('Cert:\\LocalMachine\\My\\' + $b.zertifikat) -ErrorAction SilentlyContinue; $z = [ordered]@{ thumbprint = $b.zertifikat; subjekt = $(if ($c) { $c.Subject } else { '' }); bis = $(if ($c) { $c.NotAfter.ToString('s') } else { '' }); gruende = @(ZertGruende $b.zertifikat $engine) } }",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; instanz = $inst; konfiguriert = $b.zertifikat; force = $b.force; strikt = $b.strikt; geladen = $g; start = $st.ToString('s'); engineKonto = $engine; neustartAusstehend = [bool]$ausstehend; gemerkt = $(if ($m) { [ordered]@{ zertifikat = [string]$m.vorher.zertifikat; force = [int]$m.vorher.force; zeit = [string]$m.zeit } } else { $null }); geaendert = $(if ($geaendert) { $geaendert.ToString('s') } else { '' }); zertifikat = $z; bindungsHash = (BindungsHash $b) })",
  ]);
}

export function sqlTlsStatusText(s: SqlTlsStatus): string {
  const geladen = s.geladen.art === 'zertifikat' ? s.geladen.thumbprint : s.geladen.art === 'selbsterzeugt' ? 'selbst erzeugtes Ersatzzertifikat' : 'unbekannt (kein Eintrag im aktuellen Fehlerprotokoll)';
  const z = s.zertifikat ? `; Zertifikat ${s.zertifikat.subjekt || '—'} bis ${s.zertifikat.bis || '—'}${s.zertifikat.gruende.length ? ` — BEFUNDE: ${s.zertifikat.gruende.join('; ')}` : ', Gates ok'}` : '';
  return `SQL_TLS_STATUS ${s.rechner}\\${s.instanz}: konfiguriert ${s.konfiguriert || 'keins'}, geladen ${geladen}, ForceEncryption ${s.force}${s.strikt !== null ? `, ForceStrict ${s.strikt}` : ''}, Neustart ${s.neustartAusstehend ? 'AUSSTEHEND' : 'nicht nötig'} (Start ${s.start}), Engine ${s.engineKonto}${z}; Bindungs-Hash ${s.bindungsHash}`;
}

// ── Pos. 22 — Binden und Wiederherstellen ───────────────────────────────────────────────────────────────────────────────────────────

export interface Bindung { thumbprint: string; force_encryption: boolean; erwarteter_vorher_hash?: string }
export function pruefeBindung(o: Record<string, unknown>): Bindung | string {
  const tp = String(o.thumbprint ?? '').replace(/\s/g, '').toUpperCase();
  if (!THUMB.test(tp)) return 'thumbprint: 40 Hex-Zeichen des Zertifikats in LocalMachine\\My';
  if (o.force_encryption !== undefined && typeof o.force_encryption !== 'boolean') return 'force_encryption: true oder false (Standard true)';
  const h = o.erwarteter_vorher_hash === undefined ? undefined : String(o.erwarteter_vorher_hash).trim().toLowerCase();
  if (h !== undefined && !HASH.test(h)) return 'erwarteter_vorher_hash: Bindungs-Hash aus zertifikat_status (64 Hex)';
  return { thumbprint: tp, force_encryption: o.force_encryption !== false, ...(h ? { erwarteter_vorher_hash: h } : {}) };
}

export function bindenSkript(b: Bindung & { instanz?: string }): string {
  return skript(b, [
    '$engine = EngineKonto; $vor = Bindung; $vorHash = BindungsHash $vor',
    "if ($p.erwarteter_vorher_hash -and $p.erwarteter_vorher_hash -ne $vorHash) { throw ('Bindung hat sich geändert (Hash ' + $vorHash + ' statt ' + $p.erwarteter_vorher_hash + ') — erst zertifikat_status lesen') }",
    '$g = @(ZertGruende $p.thumbprint $engine)',
    "if ($g.Count) { throw ('Zertifikat ' + $p.thumbprint + ' nicht bindbar: ' + ($g -join '; ')) }",
    '$soll = $(if ($p.force_encryption) { 1 } else { 0 })',
    "if ($vor.zertifikat -eq $p.thumbprint -and $vor.force -eq $soll) { $zustand = 'schon gebunden' } else {",
    // Zustand unmittelbar vor DIESER Änderung merken (Wiederholung ändert nichts mehr und überschreibt ihn daher nicht)
    "  New-Item -ItemType Directory -Path $merkDir -Force | Out-Null",
    "  [IO.File]::WriteAllText($merk, ([ordered]@{ vorher = $vor; vorherHash = $vorHash; zeit = (Get-Date).ToString('o'); geaendert = (Get-Date).ToString('o'); durch = 'zertifikat_binden' } | ConvertTo-Json -Compress))",
    "  Set-ItemProperty -LiteralPath $nk -Name 'Certificate' -Value $p.thumbprint.ToLower() -Type String",
    "  Set-ItemProperty -LiteralPath $nk -Name 'ForceEncryption' -Value $soll -Type DWord",
    "  $zustand = 'gebunden'",
    '}',
    '$nach = Bindung',
    "if ($nach.zertifikat -ne $p.thumbprint -or $nach.force -ne $soll) { throw ('nach dem Schreiben gelesen: ' + $nach.zertifikat + ' / ForceEncryption ' + $nach.force) }",
    "Ergebnis ([ordered]@{ zustand = $zustand; rechner = $env:COMPUTERNAME; instanz = $inst; vorher = $vor; nachher = $nach; vorherHash = $vorHash; nachherHash = (BindungsHash $nach); geladen = (Geladen); neustartNoetig = $true })",
  ]);
}

/** Rückweg: GENAU den gemerkten Zustand vor der letzten Bindung zurückschreiben (auch leer bzw. ForceEncryption 0); kein Neustart */
export function bindungWiederherstellenSkript(instanz?: string): string {
  return skript(instanz ? { instanz } : {}, [
    "if (-not (Test-Path -LiteralPath $merk)) { throw ('kein gemerkter Zustand vor einer Bindung (' + $merk + ') — nichts wiederherzustellen') }",
    '$m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json; $vor = Bindung',
    "$ziel = [ordered]@{ zertifikat = ([string]$m.vorher.zertifikat).Trim().ToUpper(); force = [int]$m.vorher.force }",
    "if ($vor.zertifikat -eq $ziel.zertifikat -and $vor.force -eq $ziel.force) { $zustand = 'schon wiederhergestellt' } else {",
    "  Set-ItemProperty -LiteralPath $nk -Name 'Certificate' -Value $ziel.zertifikat.ToLower() -Type String",
    "  Set-ItemProperty -LiteralPath $nk -Name 'ForceEncryption' -Value $ziel.force -Type DWord",
    "  $m.geaendert = (Get-Date).ToString('o'); $m | Add-Member -NotePropertyName wiederhergestellt -NotePropertyValue (Get-Date).ToString('o') -Force; [IO.File]::WriteAllText($merk, ($m | ConvertTo-Json -Compress -Depth 4))",
    "  $zustand = 'wiederhergestellt'",
    '}',
    '$nach = Bindung',
    "if ($nach.zertifikat -ne $ziel.zertifikat -or $nach.force -ne $ziel.force) { throw ('nach dem Schreiben gelesen: ' + $nach.zertifikat + ' / ForceEncryption ' + $nach.force) }",
    "Ergebnis ([ordered]@{ zustand = $zustand; rechner = $env:COMPUTERNAME; instanz = $inst; vorher = $vor; nachher = $nach; neustartNoetig = $true })",
  ]);
}

// ── Pos. 23 — Neustart des sekundären Replikats ────────────────────────────────────────────────────────────────────────────────────

export interface Neustart { ag: string; zeitlimit_s: number; erwarteter_primaer?: string; erwarteter_thumbprint?: string }
export function pruefeNeustart(o: Record<string, unknown>): Neustart | string {
  const ag = String(o.ag ?? '').trim(); if (!BEZEICHNER.test(ag)) return 'ag: Name der Verfügbarkeitsgruppe, z. B. ag01';
  const z = o.zeitlimit_s === undefined ? 900 : Number(o.zeitlimit_s); if (!Number.isInteger(z) || z < 120 || z > 3600) return 'zeitlimit_s: 120–3600 (Standard 900)';
  const pr = o.erwarteter_primaer === undefined ? undefined : String(o.erwarteter_primaer).trim().toUpperCase();
  if (pr !== undefined && !SERVER.test(pr)) return 'erwarteter_primaer: Servername des Primärreplikats, z. B. SQL01';
  const tp = o.erwarteter_thumbprint === undefined ? undefined : String(o.erwarteter_thumbprint).replace(/\s/g, '').toUpperCase();
  if (tp !== undefined && !THUMB.test(tp)) return 'erwarteter_thumbprint: 40 Hex';
  return { ag, zeitlimit_s: z, ...(pr ? { erwarteter_primaer: pr } : {}), ...(tp ? { erwarteter_thumbprint: tp } : {}) };
}

const AG_LOKAL = (ag: string) => `SELECT rs.role_desc o, rs.connected_state_desc c, rs.synchronization_health_desc h, ags.primary_replica p, CAST(@@SERVERNAME AS nvarchar(128)) s FROM sys.availability_groups ag JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id AND rs.is_local = 1 LEFT JOIN sys.dm_hadr_availability_group_states ags ON ags.group_id = ag.group_id WHERE ag.name = N'${ag.replace(/'/g, "''")}'`;
const AG_DBS = (ag: string) => `SELECT DB_NAME(s.database_id) d, s.synchronization_state_desc z FROM sys.dm_hadr_database_replica_states s JOIN sys.availability_groups ag ON ag.group_id = s.group_id WHERE s.is_local = 1 AND ag.name = N'${ag.replace(/'/g, "''")}'`;

export function engineNeustartSkript(n: Neustart & { instanz?: string }): string {
  return skript(n, [
    `$x = @(Sql "${AG_LOKAL(n.ag)}")`,
    "if (-not $x.Count) { throw ('dieser Rechner ist kein Replikat der AG ' + $p.ag) }",
    "$a = $x[0]; $ich = [string]$a.s",
    "if ([string]$a.o -ne 'SECONDARY') { throw ('lokale Rolle ' + $a.o + ' — Neustart nur auf dem SEKUNDÄREN Replikat (kein Primär-Neustart, kein Failover)') }",
    "if ([string]$a.c -ne 'CONNECTED' -or [string]$a.h -ne 'HEALTHY') { throw ('Replikat ' + $a.c + ' / ' + $a.h + ' — erst gesund, dann neu starten') }",
    "if (-not $a.p -or [string]$a.p -eq $ich) { throw 'kein anderes Primärreplikat bekannt' }",
    "if ($p.erwarteter_primaer -and [string]$a.p -ne $p.erwarteter_primaer) { throw ('Primär ist ' + $a.p + ' statt ' + $p.erwarteter_primaer + ' — Rollen haben sich geändert, Halt') }",
    `$nicht = @(Sql "${AG_DBS(n.ag)}" | Where-Object { [string]$_.z -ne 'SYNCHRONIZED' })`,
    "if ($nicht.Count) { throw ('nicht SYNCHRONIZED: ' + (($nicht | ForEach-Object { [string]$_.d + ' ' + [string]$_.z }) -join ', ')) }",
    "$q = @(Sql 'SELECT quorum_state_desc q FROM sys.dm_hadr_cluster'); if (-not $q.Count -or [string]$q[0].q -ne 'NORMAL_QUORUM') { throw ('Cluster-Quorum ' + $(if ($q.Count) { $q[0].q } else { 'unbekannt' })) }",
    "$weg = @(Sql \"SELECT member_name n, member_state_desc z FROM sys.dm_hadr_cluster_members WHERE member_state_desc <> 'UP'\"); if ($weg.Count) { throw ('Clustermitglieder nicht UP: ' + (($weg | ForEach-Object { [string]$_.n + ' ' + [string]$_.z }) -join ', ')) }",
    "$einzel = @(Sql \"SELECT d.name n FROM sys.databases d LEFT JOIN sys.dm_hadr_database_replica_states s ON s.database_id = d.database_id AND s.is_local = 1 WHERE d.database_id > 4 AND s.database_id IS NULL\" | ForEach-Object { [string]$_.n })",
    '$vorStart = SqlStart; $sw = [Diagnostics.Stopwatch]::StartNew()',
    "Restart-Service -Name $svc -Force",
    "Start-Service -Name $agt -ErrorAction SilentlyContinue",
    "$bis = (Get-Date).AddSeconds($p.zeitlimit_s); $letzt = ''; $ok = $false",
    'do {',
    '  Start-Sleep -Seconds 5',
    '  try {',
    "    $st = SqlStart; $y = @(Sql \"" + AG_LOKAL(n.ag) + "\"); $d = @(Sql \"" + AG_DBS(n.ag) + "\")",
    "    $offen = @($d | Where-Object { [string]$_.z -ne 'SYNCHRONIZED' })",
    "    if ($y.Count -and [string]$y[0].o -eq 'PRIMARY') { throw 'ROLLE: nach dem Neustart PRIMARY — unerwarteter Rollenwechsel, Halt' }",
    "    $letzt = $(if ($y.Count) { [string]$y[0].o + ' ' + [string]$y[0].c + ' ' + [string]$y[0].h } else { 'ohne AG-Zustand' }) + '; nicht synchron: ' + $offen.Count",
    "    $ok = $st -gt $vorStart -and $y.Count -and [string]$y[0].o -eq 'SECONDARY' -and [string]$y[0].c -eq 'CONNECTED' -and [string]$y[0].h -eq 'HEALTHY' -and $d.Count -and -not $offen.Count",
    "  } catch { if ([string]$_.Exception.Message -like 'ROLLE:*') { throw }; $letzt = $_.Exception.Message }",
    '} while (-not $ok -and (Get-Date) -lt $bis)',
    "if (-not $ok) { throw ('nach ' + $p.zeitlimit_s + ' s nicht wieder SECONDARY/CONNECTED/HEALTHY/SYNCHRONIZED — zuletzt: ' + $letzt) }",
    "$agt2 = [string](Get-Service -Name $agt -ErrorAction SilentlyContinue).Status",
    '$b = Bindung; $g = Geladen',
    "if ($p.erwarteter_thumbprint -and $g.thumbprint -ne $p.erwarteter_thumbprint) { throw ('nach dem Neustart geladen: ' + $(if ($g.thumbprint) { $g.thumbprint } else { $g.art }) + ' statt ' + $p.erwarteter_thumbprint + ' (' + $g.zeile + ')') }",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; server = $ich; ag = $p.ag; primaer = [string]$a.p; vorherStart = $vorStart.ToString('s'); start = (SqlStart).ToString('s'); sekunden = [int]$sw.Elapsed.TotalSeconds; rolle = 'SECONDARY'; zustand = 'CONNECTED HEALTHY'; datenbanken = @($d | ForEach-Object { [string]$_.d + ' ' + [string]$_.z }); agent = $agt2; konfiguriert = $b.zertifikat; force = $b.force; geladen = $g; ohneAg = $einzel })",
  ]);
}

/**
 * v1857 — bewachter Wiederanlauf (Spec „Rückweg exakt alte Bindung … auf sekundärem Knoten, gezielter Restart, gesunden Primär
 * unangetastet“): für den Fall, dass SQL mit der neuen Bindung NICHT mehr hochkommt — dann greifen die Eingangsprüfungen von
 * engine_neustart (lokal SECONDARY/HEALTHY) nicht. Prüft deshalb über den Cluster (nicht über die lokale Instanz): AG-Gruppe online
 * beim erwarteten Primär (nie dieser Knoten), alle Knoten Up, Zeuge online; die Bindung muss dem gemerkten Zustand vor der letzten
 * Bindung entsprechen (erst zertifikat_bindung_wiederherstellen). Dann Dienst (neu) starten und warten bis SECONDARY/CONNECTED/
 * HEALTHY/SYNCHRONIZED; geladen muss die wiederhergestellte Bindung sein (leer = selbst erzeugtes Ersatzzertifikat).
 */
export interface Wiederanlauf { ag: string; erwarteter_primaer: string; zeitlimit_s: number }
export function pruefeWiederanlauf(o: Record<string, unknown>): Wiederanlauf | string {
  const ag = String(o.ag ?? '').trim(); if (!BEZEICHNER.test(ag)) return 'ag: Name der Verfügbarkeitsgruppe, z. B. ag01';
  const pr = String(o.erwarteter_primaer ?? '').trim().toUpperCase(); if (!SERVER.test(pr)) return 'erwarteter_primaer: Pflicht — gesundes Primärreplikat, das unangetastet bleibt, z. B. SQL01';
  const z = o.zeitlimit_s === undefined ? 900 : Number(o.zeitlimit_s); if (!Number.isInteger(z) || z < 120 || z > 3600) return 'zeitlimit_s: 120–3600 (Standard 900)';
  return { ag, erwarteter_primaer: pr, zeitlimit_s: z };
}

export function engineWiederanlaufSkript(w: Wiederanlauf & { instanz?: string }): string {
  return skript(w, [
    "if (-not (Get-Service -Name ClusSvc -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running')) { throw 'Clusterdienst läuft nicht' }",
    'Import-Module FailoverClusters',
    "$primKnoten = ([string]$p.erwarteter_primaer -split '\\\\')[0]",
    "if ($primKnoten -ieq $env:COMPUTERNAME) { throw ('erwarteter Primär ist dieser Knoten — Wiederanlauf nur auf dem Nicht-Primärknoten') }",
    "$gr = Get-ClusterGroup -Name $p.ag -ErrorAction SilentlyContinue; if (-not $gr) { throw ('Clustergruppe ' + $p.ag + ' nicht gefunden') }",
    "if ([string]$gr.State -ne 'Online' -or [string]$gr.OwnerNode.Name -ine $primKnoten) { throw ('AG ' + $p.ag + ' ' + $gr.State + ' bei ' + $gr.OwnerNode.Name + ' statt Online bei ' + $primKnoten + ' — Halt, Primär nicht wie erwartet') }",
    "$weg = @(Get-ClusterNode | Where-Object { [string]$_.State -ne 'Up' }); if ($weg.Count) { throw ('Knoten nicht Up: ' + (($weg | ForEach-Object { [string]$_.Name + ' ' + [string]$_.State }) -join ', ')) }",
    "$q = Get-ClusterQuorum; if ($q.QuorumResource -and [string]$q.QuorumResource.State -ne 'Online') { throw ('Zeuge ' + $q.QuorumResource.Name + ' ' + $q.QuorumResource.State) }",
    // lokale Rolle nur, wenn die Instanz antwortet — PRIMARY ist ausgeschlossen
    "$vorStart = $null; try { $x = @(Sql \"" + AG_LOKAL(w.ag) + "\"); if ($x.Count -and [string]$x[0].o -eq 'PRIMARY') { throw 'ROLLE: dieser Knoten ist PRIMARY — kein Wiederanlauf' }; $vorStart = SqlStart } catch { if ([string]$_.Exception.Message -like 'ROLLE:*') { throw }; }",
    "if (-not (Test-Path -LiteralPath $merk)) { throw 'kein gemerkter Zustand vor einer Bindung — nichts wiederherzustellen' }",
    '$m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json; $b = Bindung',
    "$sollZ = ([string]$m.vorher.zertifikat).Trim().ToUpper(); $sollF = [int]$m.vorher.force",
    "if ($b.zertifikat -ne $sollZ -or $b.force -ne $sollF) { throw ('Bindung ' + $(if ($b.zertifikat) { $b.zertifikat } else { 'keins' }) + '/' + $b.force + ' entspricht nicht dem gemerkten Zustand ' + $(if ($sollZ) { $sollZ } else { 'keins' }) + '/' + $sollF + ' — erst zertifikat_bindung_wiederherstellen') }",
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    "$dienst = Get-Service -Name $svc; if ([string]$dienst.Status -eq 'Running') { Restart-Service -Name $svc -Force } else { Start-Service -Name $svc }",
    "Start-Service -Name $agt -ErrorAction SilentlyContinue",
    "$bis = (Get-Date).AddSeconds($p.zeitlimit_s); $letzt = ''; $ok = $false",
    'do {',
    '  Start-Sleep -Seconds 5',
    '  try {',
    "    $st = SqlStart; $y = @(Sql \"" + AG_LOKAL(w.ag) + "\"); $d = @(Sql \"" + AG_DBS(w.ag) + "\")",
    "    $offen = @($d | Where-Object { [string]$_.z -ne 'SYNCHRONIZED' })",
    "    if ($y.Count -and [string]$y[0].o -eq 'PRIMARY') { throw 'ROLLE: nach dem Wiederanlauf PRIMARY — unerwarteter Rollenwechsel, Halt' }",
    "    $letzt = $(if ($y.Count) { [string]$y[0].o + ' ' + [string]$y[0].c + ' ' + [string]$y[0].h } else { 'ohne AG-Zustand' }) + '; nicht synchron: ' + $offen.Count",
    "    $ok = (-not $vorStart -or $st -gt $vorStart) -and $y.Count -and [string]$y[0].o -eq 'SECONDARY' -and [string]$y[0].c -eq 'CONNECTED' -and [string]$y[0].h -eq 'HEALTHY' -and $d.Count -and -not $offen.Count",
    "  } catch { if ([string]$_.Exception.Message -like 'ROLLE:*') { throw }; $letzt = $_.Exception.Message }",
    '} while (-not $ok -and (Get-Date) -lt $bis)',
    "if (-not $ok) { throw ('nach ' + $p.zeitlimit_s + ' s nicht wieder SECONDARY/CONNECTED/HEALTHY/SYNCHRONIZED — zuletzt: ' + $letzt) }",
    '$g = Geladen',
    "if ($sollZ -and $g.thumbprint -ne $sollZ) { throw ('geladen ' + $(if ($g.thumbprint) { $g.thumbprint } else { $g.art }) + ' statt wiederhergestelltem ' + $sollZ) }",
    "if (-not $sollZ -and $g.art -ne 'selbsterzeugt') { throw ('geladen ' + $g.art + ' ' + $g.thumbprint + ' statt selbst erzeugtem Ersatzzertifikat (Bindung leer)') }",
    "$gr2 = Get-ClusterGroup -Name $p.ag",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; ag = $p.ag; primaer = [string]$gr2.OwnerNode.Name; agZustand = [string]$gr2.State; vorherStart = $(if ($vorStart) { $vorStart.ToString('s') } else { 'nicht erreichbar' }); start = (SqlStart).ToString('s'); sekunden = [int]$sw.Elapsed.TotalSeconds; datenbanken = @($d | ForEach-Object { [string]$_.d + ' ' + [string]$_.z }); agent = [string](Get-Service -Name $agt -ErrorAction SilentlyContinue).Status; konfiguriert = $b.zertifikat; force = $b.force; geladen = $g })",
  ]);
}

// ── Pos. 24/25 — echte TLS-Prüfung (Listener oder Knoten) ──────────────────────────────────────────────────────────────────────────

/**
 * TDS-Prelogin (MS-TDS 2.2.6.5): mit ENCRYPT_ON und TLS-Handschlag in TDS-Paketen das vom Server vorgelegte Zertifikat holen (der
 * Handschlag wird danach abgebrochen, keine Anmeldung); mit ENCRYPT_OFF zeigt die Antwort, ob der Server Verschlüsselung erzwingt
 * (0 = aus, sonst erzwungen/verlangt).
 */
export const TDS_PROBE = [
  "if (-not ('AlfredTdsProbe' -as [type])) {",
  "Add-Type -TypeDefinition @'",
  'using System; using System.IO; using System.Net.Security; using System.Net.Sockets; using System.Security.Authentication; using System.Security.Cryptography.X509Certificates;',
  'public class AlfredTdsProbe {',
  '  class TdsHuelle : Stream {',
  '    readonly Stream innen; byte[] puffer = new byte[0]; int pos = 0;',
  '    public TdsHuelle(Stream s) { innen = s; }',
  '    public override bool CanRead { get { return true; } } public override bool CanSeek { get { return false; } } public override bool CanWrite { get { return true; } }',
  '    public override long Length { get { throw new NotSupportedException(); } } public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }',
  '    public override void Flush() { innen.Flush(); } public override long Seek(long o, SeekOrigin h) { throw new NotSupportedException(); } public override void SetLength(long l) { throw new NotSupportedException(); }',
  '    public override int Read(byte[] b, int o, int n) { if (pos >= puffer.Length) { byte[] k = Lies(innen, 8); int len = (k[2] << 8) | k[3]; puffer = Lies(innen, len - 8); pos = 0; } int m = Math.Min(n, puffer.Length - pos); Array.Copy(puffer, pos, b, o, m); pos += m; return m; }',
  '    public override void Write(byte[] b, int o, int n) { byte[] p = new byte[n + 8]; p[0] = 0x12; p[1] = 0x01; p[2] = (byte)((n + 8) >> 8); p[3] = (byte)((n + 8) & 0xff); Array.Copy(b, o, p, 8, n); innen.Write(p, 0, p.Length); innen.Flush(); }',
  '  }',
  '  static byte[] Lies(Stream s, int n) { byte[] x = new byte[n]; int g = 0; while (g < n) { int r = s.Read(x, g, n - g); if (r <= 0) throw new IOException("Verbindung vom Server beendet"); g += r; } return x; }',
  '  static int Prelogin(Stream s, byte v) {',
  '    byte[] nutz = new byte[18]; nutz[0] = 0x00; nutz[2] = 11; nutz[4] = 6; nutz[5] = 0x01; nutz[7] = 17; nutz[9] = 1; nutz[10] = 0xFF; nutz[11] = 0x10; nutz[17] = v;',
  '    byte[] p = new byte[nutz.Length + 8]; p[0] = 0x12; p[1] = 0x01; p[2] = (byte)(p.Length >> 8); p[3] = (byte)(p.Length & 0xff); Array.Copy(nutz, 0, p, 8, nutz.Length); s.Write(p, 0, p.Length); s.Flush();',
  '    byte[] k = Lies(s, 8); if (k[0] != 0x04) throw new IOException("keine TDS-Antwort (Typ " + k[0] + ")"); int len = (k[2] << 8) | k[3]; byte[] a = Lies(s, len - 8);',
  '    int i = 0; while (i + 4 < a.Length && a[i] != 0xFF) { int off = (a[i + 1] << 8) | a[i + 2]; if (a[i] == 0x01 && off < a.Length) return a[off]; i += 5; } return -1;',
  '  }',
  '  static TcpClient Verbinde(string ziel, int port, int ms) { TcpClient c = new TcpClient(); IAsyncResult ar = c.BeginConnect(ziel, port, null, null); if (!ar.AsyncWaitHandle.WaitOne(ms)) { c.Close(); throw new IOException("keine Verbindung zu " + ziel + ":" + port); } c.EndConnect(ar); c.ReceiveTimeout = ms; c.SendTimeout = ms; return c; }',
  '  public static int Verschluesselung(string ziel, int port, int v, int ms) { using (TcpClient c = Verbinde(ziel, port, ms)) { return Prelogin(c.GetStream(), (byte)v); } }',
  '  public static X509Certificate2 Zertifikat(string ziel, int port, int ms) {',
  '    using (TcpClient c = Verbinde(ziel, port, ms)) {',
  '      NetworkStream s = c.GetStream(); int a = Prelogin(s, 0x01); if (a != 0x01 && a != 0x03) throw new IOException("Server bietet keine Verschlüsselung an (Prelogin-Antwort " + a + ")");',
  '      X509Certificate2 gesehen = null;',
  '      using (SslStream t = new SslStream(new TdsHuelle(s), true, (snd, cert, kette, fehler) => { if (cert != null) gesehen = new X509Certificate2(cert.GetRawCertData()); return true; })) {',
  '        try { t.AuthenticateAsClient(ziel, null, SslProtocols.Tls12, false); } catch (Exception) { if (gesehen == null) throw; }',
  '      }',
  '      if (gesehen == null) throw new IOException("kein Zertifikat vom Server"); return gesehen;',
  '    }',
  '  }',
  '}',
  "'@",
  '}',
];

export interface TlsTest { ziel: string; port: number; erwarteter_thumbprint?: string; erwarteter_server?: string; erwartete_rolle?: 'PRIMARY' | 'SECONDARY'; erzwungen?: boolean }
export function pruefeTlsTest(o: Record<string, unknown>): TlsTest | string {
  const ziel = String(o.ziel ?? o.listener ?? '').trim().toLowerCase(); if (!FQDN.test(ziel)) return 'ziel: vollständiger DNS-Name des Listeners oder Knotens, z. B. sqlag01.ad.3033.at';
  const port = o.port === undefined ? 1433 : Number(o.port); if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port: Standard 1433';
  const r: TlsTest = { ziel, port };
  if (o.erwarteter_thumbprint !== undefined) { const t = String(o.erwarteter_thumbprint).replace(/\s/g, '').toUpperCase(); if (!THUMB.test(t)) return 'erwarteter_thumbprint: 40 Hex'; r.erwarteter_thumbprint = t; }
  if (o.erwarteter_server !== undefined) { const s = String(o.erwarteter_server).trim().toUpperCase(); if (!SERVER.test(s)) return 'erwarteter_server: z. B. SQL02'; r.erwarteter_server = s; }
  if (o.erwartete_rolle !== undefined) { const ro = String(o.erwartete_rolle).trim().toUpperCase(); if (ro !== 'PRIMARY' && ro !== 'SECONDARY') return 'erwartete_rolle: PRIMARY oder SECONDARY'; r.erwartete_rolle = ro; }
  if (o.erzwungen !== undefined) { if (typeof o.erzwungen !== 'boolean') return 'erzwungen: true (Server muss Verschlüsselung erzwingen) oder false'; r.erzwungen = o.erzwungen; }
  return r;
}

export interface TlsBefund {
  probe: { thumbprint: string; subjekt: string; aussteller: string; sans: string[]; von: string; bis: string; kette: boolean; kettenStatus: string[]; antwortUnverschluesselt: number; zeit: string; fehler?: string };
  anmeldung: { server?: string; rolle?: string; anmeldung?: string; konto?: string; verschluesselt?: boolean; transport?: string; ms?: number; treiber?: string; fehler?: string };
}

export function tlsTestSkript(t: TlsTest & { ausKonto?: string }): string {
  const innen = innenSkript(t, [
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'try {',
    // strenge Prüfung: Encrypt=True, TrustServerCertificate=False (Name/Kette prüft der Treiber über SChannel)
    "  $cn = New-Object System.Data.SqlClient.SqlConnection ('Server=tcp:' + $p.ziel + ',' + $p.port + ';Database=master;Integrated Security=SSPI;Encrypt=True;TrustServerCertificate=False;MultiSubnetFailover=True;Connect Timeout=20;Pooling=false;Application Name=Alfred-TLS-Test')",
    '  $cn.Open()',
    '  try {',
    '    $cmd = $cn.CreateCommand()',
    "    $cmd.CommandText = \"SELECT CAST(@@SERVERNAME AS nvarchar(128)) s, c.auth_scheme a, c.encrypt_option e, c.net_transport t, SUSER_SNAME() u, (SELECT TOP 1 rs.role_desc FROM sys.dm_hadr_availability_replica_states rs WHERE rs.is_local = 1) r FROM sys.dm_exec_connections c WHERE c.session_id = @@SPID\"",
    '    $rd = $cmd.ExecuteReader(); [void]$rd.Read()',
    "    $w = [ordered]@{ server = [string]$rd['s']; rolle = [string]$rd['r']; anmeldung = [string]$rd['a']; konto = [string]$rd['u']; verschluesselt = ([string]$rd['e'] -eq 'TRUE'); transport = [string]$rd['t']; ms = $sw.ElapsedMilliseconds; treiber = [string]$cn.ServerVersion + ' / System.Data ' + [string]([System.Data.SqlClient.SqlConnection].Assembly.GetName().Version) }",
    '    $rd.Close(); $w',
    '  } finally { $cn.Close() }',
    "} catch { [ordered]@{ fehler = ([string]$_.Exception.Message -replace '\\s+', ' ') } }",
  ]);
  return [
    ...kopf(t, true), MIT_KONTO, ...TDS_PROBE,
    "function Sans($c) { $x = $c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }; if (-not $x) { return @() }; @(($x.Format($false) -split ',\\s*') | Where-Object { $_ -match '^(DNS Name|DNS-Name)=' } | ForEach-Object { ($_ -replace '^(DNS Name|DNS-Name)=', '').Trim().ToLower() }) }",
    '$probe = [ordered]@{ zeit = (Get-Date).ToString(\'s\') }',
    'try {',
    '  $probe.antwortUnverschluesselt = [AlfredTdsProbe]::Verschluesselung($p.ziel, $p.port, 0, 20000)',
    '  $c = [AlfredTdsProbe]::Zertifikat($p.ziel, $p.port, 20000)',
    "  $ch = New-Object Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode = 'Online'; $ch.ChainPolicy.RevocationFlag = 'EntireChain'; $ch.ChainPolicy.UrlRetrievalTimeout = New-TimeSpan -Seconds 30",
    "  [void]$ch.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid '1.3.6.1.5.5.7.3.1'))",
    '  $probe.kette = $ch.Build($c); $probe.kettenStatus = @(@($ch.ChainStatus | ForEach-Object { [string]$_.Status }) | Select-Object -Unique)',
    "  $probe.thumbprint = $c.Thumbprint; $probe.subjekt = $c.Subject; $probe.aussteller = $c.Issuer; $probe.sans = @(Sans $c); $probe.von = $c.NotBefore.ToString('s'); $probe.bis = $c.NotAfter.ToString('s')",
    "} catch { $probe.fehler = ([string]$_.Exception.Message -replace '\\s+', ' ') }",
    '$nb = DomaeneNetbios',
    `$w = MitKonto (${kontoAusdruck('alfred', '$nb')}) $e.kennwort ${psText(innen)} 120`,
    'Ergebnis ([ordered]@{ probe = $probe; anmeldung = $w })',
  ].join('\n');
}

/** Abnahme SQL_TLS_VERIFIED: Zertifikat (Thumbprint, Name im SAN, Kette + Online-Sperrprüfung), Erzwingen, Anmeldung (Kerberos, verschlüsselt, Server, Rolle) */
export function bewerteTlsTest(t: TlsTest, b: TlsBefund): { ok: boolean; gruende: string[] } {
  const g: string[] = [];
  const p = b.probe;
  if (p.fehler) g.push(`TDS-Probe: ${p.fehler}`);
  else {
    if (t.erwarteter_thumbprint && p.thumbprint?.toUpperCase() !== t.erwarteter_thumbprint) g.push(`vorgelegt ${p.thumbprint} statt ${t.erwarteter_thumbprint}`);
    if (!(p.sans ?? []).includes(t.ziel)) g.push(`${t.ziel} nicht im SAN (${(p.sans ?? []).join(',') || p.subjekt})`);
    if (!p.kette || (p.kettenStatus ?? []).some(s => s !== 'NoError')) g.push(`Kette/Sperrprüfung: ${(p.kettenStatus ?? []).join(', ') || 'nicht aufgebaut'}`);
    const erzwungen = p.antwortUnverschluesselt !== 0;
    if (t.erzwungen !== undefined && erzwungen !== t.erzwungen) g.push(`Server ${erzwungen ? 'erzwingt' : 'erzwingt NICHT'} Verschlüsselung (Prelogin-Antwort ${p.antwortUnverschluesselt})`);
  }
  const a = b.anmeldung ?? {};
  if (a.fehler) g.push(`Anmeldung mit Encrypt=True/TrustServerCertificate=False: ${a.fehler}`);
  else {
    if (a.anmeldung !== 'KERBEROS') g.push(`Anmeldung über ${a.anmeldung || '?'} statt KERBEROS`);
    if (a.verschluesselt !== true) g.push('Verbindung nicht verschlüsselt');
    if (t.erwarteter_server && (a.server ?? '').toUpperCase() !== t.erwarteter_server) g.push(`Server ${a.server} statt ${t.erwarteter_server}`);
    if (t.erwartete_rolle && (a.rolle ?? '').toUpperCase() !== t.erwartete_rolle) g.push(`Rolle ${a.rolle || '—'} statt ${t.erwartete_rolle}`);
  }
  return { ok: g.length === 0, gruende: g };
}

export function tlsTestText(t: TlsTest, b: TlsBefund, e: { ok: boolean; gruende: string[] }): string {
  const p = b.probe; const a = b.anmeldung ?? {};
  const zert = p.fehler ? `Probe gescheitert: ${p.fehler}` : `vorgelegt ${p.thumbprint} ${p.subjekt} (Aussteller ${p.aussteller}, ${p.von} – ${p.bis}), SAN ${(p.sans ?? []).join(',')}, Kette ${p.kette ? 'ok' : 'NICHT ok'} (online: ${(p.kettenStatus ?? []).join(', ') || 'ohne Befund'}), Verschlüsselung ${p.antwortUnverschluesselt !== 0 ? `erzwungen (Prelogin ${p.antwortUnverschluesselt})` : 'NICHT erzwungen (Prelogin 0)'}`;
  const anm = a.fehler ? `Anmeldung gescheitert: ${a.fehler}` : `Anmeldung ${a.konto} über ${a.anmeldung} → ${a.server} (${a.rolle || 'ohne AG-Rolle'}), ${a.verschluesselt ? 'verschlüsselt' : 'UNVERSCHLÜSSELT'}, Encrypt=True, TrustServerCertificate=False, ${a.transport}, ${a.ms} ms, Treiber ${a.treiber}`;
  return `${e.ok ? '✅ SQL_TLS_VERIFIED' : 'SQL-TLS NICHT wie erwartet'} ${t.ziel}:${t.port} (${p.zeit}): ${zert}; ${anm}${e.gruende.length ? ` — BEFUNDE: ${e.gruende.join('; ')}` : ''}`;
}
