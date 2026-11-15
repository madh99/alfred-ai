/**
 * PKI Etappe 5 — TLS-Negativtest-Lab (Spec Pos. 25; Owner 14.11.: Wegwerf-Lab-CA + Test-SQL-Instanz ohne AG in einem eigenen
 * isolierten VLAN, produktive CA/CRL und produktiver Truststore unberührt). Jeder Baustein prüft zuerst, dass er auf einem Lab-Rechner
 * läuft (LAB_WAECHTER): keine Domäne, Name LAB…, Adresse im Lab-Netz 10.203.32.0/28. Fälle: unbekannte CA, falscher Name, abgelaufen,
 * gesperrt, Sperrliste nicht erreichbar — Ergebnis EXPECTED_TLS_FAILURE mit passendem Grund, nie aus einem bloßen Verbindungsfehler.
 */
import { kopf, psText } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';
import { TDS_PROBE } from './sql-tls-bindung.js';

export const LAB_NETZ = /^10\.203\.32\.([0-9]|1[0-5])$/;
export const LAB_SUFFIX = 'pkilab.test';
export const LAB_CA_NAME = 'PKI-Lab Root CA';
export const LAB_LOGIN = 'alfredlab';
const LAB_NAME = /^(?=.{3,80}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+pkilab\.test$/;
const THUMB = /^[0-9A-F]{40}$/;

/** Erste Zeilen jedes Lab-Bausteins: nie auf einem Produktionsrechner */
export const LAB_WAECHTER = [
  String.raw`$cs = Get-CimInstance -ClassName Win32_ComputerSystem`,
  String.raw`if ($cs.PartOfDomain) { throw ('Lab-Baustein nur auf Rechnern ohne Domäne — ' + $env:COMPUTERNAME + ' ist Mitglied von ' + $cs.Domain) }`,
  String.raw`if ($env:COMPUTERNAME -notmatch '^LAB') { throw ('Lab-Baustein nur auf Lab-Rechnern (Name LAB…), nicht ' + $env:COMPUTERNAME) }`,
  String.raw`if (-not @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^10\.203\.32\.([0-9]|1[0-5])$' }).Count) { throw 'Lab-Baustein nur mit einer Adresse im Lab-Netz 10.203.32.0/28' }`,
];

const lab = (p: unknown, mitEingabe: boolean, zeilen: string[]) => [...kopf(p, mitEingabe), ...LAB_WAECHTER, ...zeilen].join('\n');
/** als SYSTEM über eine geplante Aufgabe (CA-Einrichtung, Zertifikate im Maschinenspeicher); der Wächter läuft außen UND innen */
const labAlsSystem = (p: unknown, rumpf: string[], sekunden: number) => lab(p, false, [MIT_KONTO, `$w = MitKonto 'SYSTEM' '' ${psText(innenSkript(p, [...LAB_WAECHTER, ...rumpf]))} ${sekunden}`, 'Ergebnis $w']);

// ── Namen (hosts) und primäres DNS-Suffix ───────────────────────────────────────────────────────────────────────────────
export interface LabNamen { eintraege: Array<{ name: string; ip: string }> }
export function pruefeLabNamen(o: Record<string, unknown>): LabNamen | string {
  if (!Array.isArray(o.eintraege) || !o.eintraege.length || o.eintraege.length > 12) return 'eintraege: 1–12 × { name: <x>.pkilab.test, ip: 10.203.32.0/28 }';
  const e: LabNamen['eintraege'] = [];
  for (const x of o.eintraege as Array<Record<string, unknown>>) {
    const name = String(x?.name ?? '').trim().toLowerCase(), ip = String(x?.ip ?? '').trim();
    if (!LAB_NAME.test(name)) return `Name ${name || '—'}: nur <x>.${LAB_SUFFIX}`;
    if (!LAB_NETZ.test(ip)) return `IP ${ip || '—'}: nur 10.203.32.0/28`;
    e.push({ name, ip });
  }
  return { eintraege: e };
}
export function labNamenSkript(n: LabNamen): string {
  return lab({ ...n, suffix: LAB_SUFFIX }, false, [
    String.raw`$h = Join-Path $env:windir 'System32\drivers\etc\hosts'; $nl = [Environment]::NewLine`,
    String.raw`$alt = [IO.File]::ReadAllText($h)`,
    String.raw`$ohne = [regex]::Replace($alt, '(?s)\r?\n?# Alfred PKI-Lab Anfang.*?# Alfred PKI-Lab Ende\r?\n?', $nl).TrimEnd()`,
    String.raw`$block = '# Alfred PKI-Lab Anfang' + $nl + ((@($p.eintraege) | ForEach-Object { $_.ip + ' ' + $_.name }) -join $nl) + $nl + '# Alfred PKI-Lab Ende' + $nl`,
    String.raw`[IO.File]::WriteAllText($h, $ohne + $nl + $block, [Text.Encoding]::ASCII)`,
    String.raw`$k = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters'; $vor = [string](Get-ItemProperty $k).'NV Domain'`,
    String.raw`$neustart = $false; if ($vor -ne $p.suffix) { Set-ItemProperty $k -Name 'NV Domain' -Value $p.suffix; $neustart = $true }`,
    String.raw`Clear-DnsClientCache`,
    String.raw`$auf = @(@($p.eintraege) | ForEach-Object { $n = $_.name; $a = @([Net.Dns]::GetHostAddresses($n) | ForEach-Object { $_.IPAddressToString }); [ordered]@{ name = $n; ip = ($a -join ',') } })`,
    String.raw`Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; suffixVorher = $vor; suffix = $p.suffix; neustart = $neustart; aufgeloest = $auf })`,
  ]);
}

// ── Lab-CA (Standalone-Root, Sperrliste über HTTP) ─────────────────────────────────────────────────────────────────────
export function labCaSkript(p: { crl_host: string }): string {
  return labAlsSystem({ ...p, ca_name: LAB_CA_NAME }, [
    String.raw`$k = 'HKLM:\SYSTEM\CurrentControlSet\Services\CertSvc\Configuration'`,
    String.raw`$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })`,
    String.raw`if ($aktiv -and $aktiv -ne $p.ca_name) { throw ('auf diesem Rechner ist schon eine andere CA eingerichtet: ' + $aktiv) }`,
    String.raw`$f = Install-WindowsFeature -Name ADCS-Cert-Authority, Web-Server`,
    String.raw`if (-not $aktiv) {`,
    // ohne Domäne setzt das Setup sonst den Freigabeordner \\<rechner>\CertConfig (Realfall v1861) — leer lassen
    String.raw`  $s = New-Object -ComObject CertOCM.CertSrvSetup`,
    String.raw`  $s.InitializeDefaults($true, $false)`,
    String.raw`  $s.SetCASetupProperty(0, 3)`,
    String.raw`  $s.SetCADistinguishedName(('CN=' + $p.ca_name), $true, $true, $true)`,
    String.raw`  $db = Join-Path $env:windir 'System32\CertLog'; $s.SetDatabaseInformation($db, $db, '', $true)`,
    String.raw`  if ([string]$s.GetCASetupProperty(11)) { throw 'Freigabeordner ließ sich nicht abschalten' }`,
    String.raw`  try { $s.Install() } catch { $z = $(try { [string]$s.CAErrorString } catch { '' }); throw ('CA-Setup: ' + $_.Exception.Message + ' ' + $z) }`,
    String.raw`}`,
    String.raw`$web = 'C:\inetpub\wwwroot\pki'; New-Item -ItemType Directory -Path $web -Force | Out-Null`,
    String.raw`function Reg($n, $v) { $o = (& certutil.exe -setreg $n $v 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw ('certutil -setreg ' + $n + ': ' + $o.Trim()) } }`,
    String.raw`Reg 'CA\CRLPublicationURLs' ('1:' + $web + '\lab%8.crl\n2:http://' + $p.crl_host + '/pki/lab%8.crl')`,
    String.raw`Reg 'CA\CACertPublicationURLs' ('1:' + $web + '\lab-root%4.crt\n2:http://' + $p.crl_host + '/pki/lab-root%4.crt')`,
    String.raw`Reg 'CA\CRLPeriodUnits' '7'; Reg 'CA\CRLPeriod' 'Days'; Reg 'CA\CRLDeltaPeriodUnits' '0'; Reg 'CA\ValidityPeriodUnits' '1'; Reg 'CA\ValidityPeriod' 'Years'`,
    // nur im Lab: Anforderungen sofort ausstellen, Laufzeit aus der Anforderung erlaubt (Fall „abgelaufen“)
    String.raw`Reg 'policy\RequestDisposition' '1'; Reg 'policy\EditFlags' '+EDITF_ATTRIBUTEENDDATE'`,
    String.raw`Restart-Service CertSvc -Force`,
    String.raw`$bis = (Get-Date).AddMinutes(2); do { Start-Sleep -Seconds 3; $ok = (& certutil.exe -ping 2>&1 | Out-String) -match 'interface is alive|Schnittstelle ist aktiv' } while (-not $ok -and (Get-Date) -lt $bis)`,
    String.raw`if (-not $ok) { throw 'CertSvc antwortet nicht' }`,
    String.raw`$o = (& certutil.exe -crl 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw ('certutil -crl: ' + $o.Trim()) }`,
    String.raw`$cf = Join-Path $web 'lab-root.crt'; Remove-Item $cf -Force -ErrorAction SilentlyContinue; & certutil.exe '-ca.cert' $cf 2>&1 | Out-Null`,
    String.raw`$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cf`,
    String.raw`foreach ($r in @(@{ n = 'Alfred PKI-Lab HTTP'; p = 80 }, @{ n = 'Alfred PKI-Lab SQL'; p = 1433 })) { if (-not (Get-NetFirewallRule -DisplayName $r.n -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName $r.n -Direction Inbound -Protocol TCP -LocalPort $r.p -Action Allow -Profile Any | Out-Null } }`,
    String.raw`$crl = @(Get-ChildItem $web -Filter 'lab*.crl')`,
    String.raw`[ordered]@{ zustand = $(if ($aktiv) { 'schon eingerichtet' } else { 'eingerichtet' }); rechner = $env:COMPUTERNAME; ca = $p.ca_name; thumbprint = $c.Thumbprint; subjekt = $c.Subject; bis = $c.NotAfter.ToString('s'); crl = @($crl | ForEach-Object { $_.Name }); crlUrl = ('http://' + $p.crl_host + '/pki/lab.crl'); neustartNoetig = [bool]$f.RestartNeeded.ToString().Equals('Yes') }`,
  ], 1800);
}

/** Lab-Root als Base64 (für den Client) */
export function labRootLesenSkript(): string {
  return lab({}, false, [
    String.raw`$cf = 'C:\inetpub\wwwroot\pki\lab-root.crt'; if (-not (Test-Path $cf)) { throw 'Lab-Root fehlt — zuerst lab_ca_einrichten' }`,
    String.raw`$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cf`,
    String.raw`Ergebnis ([ordered]@{ thumbprint = $c.Thumbprint; subjekt = $c.Subject; base64 = [Convert]::ToBase64String($c.RawData) })`,
  ]);
}
export function labRootVertrauenSkript(p: { thumbprint: string }): string {
  return lab({ ...p, ca_name: LAB_CA_NAME }, true, [
    String.raw`$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 (,[Convert]::FromBase64String([string]$e.base64))`,
    String.raw`if ($c.Thumbprint -ne $p.thumbprint) { throw ('Lab-Root ' + $c.Thumbprint + ' statt ' + $p.thumbprint) }`,
    String.raw`if ($c.Subject -ne ('CN=' + $p.ca_name) -or $c.Subject -ne $c.Issuer) { throw ('kein Lab-Root: ' + $c.Subject + ' / ' + $c.Issuer) }`,
    String.raw`$st = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine'); $st.Open('ReadWrite'); $schon = [bool]($st.Certificates | Where-Object { $_.Thumbprint -eq $c.Thumbprint }); if (-not $schon) { $st.Add($c) }; $st.Close()`,
    String.raw`if (-not (Get-Item ('Cert:\LocalMachine\Root\' + $c.Thumbprint) -ErrorAction SilentlyContinue)) { throw 'Lab-Root nach dem Import nicht im Speicher' }`,
    String.raw`Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; thumbprint = $c.Thumbprint; zustand = $(if ($schon) { 'schon vertraut' } else { 'vertraut' }) })`,
  ]);
}

// ── Test-SQL-Instanz (Developer, ohne AG) ─────────────────────────────────────────────────────────────────────────────
export function labSqlInstallierenSkript(): string {
  const p = { login: LAB_LOGIN };
  const setup = [
    String.raw`$svc = 'MSSQLSERVER'`,
    String.raw`if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { return [ordered]@{ zustand = 'schon'; code = 0 } }`,
    String.raw`$cd = @(Get-Volume | Where-Object { $_.DriveType -eq 'CD-ROM' -and $_.DriveLetter } | ForEach-Object { [string]$_.DriveLetter + ':\setup.exe' } | Where-Object { Test-Path $_ })`,
    String.raw`if (-not $cd.Count) { throw 'kein SQL-Medium eingelegt (setup.exe auf keinem CD-Laufwerk) — zuerst attach_iso und reboot_vm' }`,
    String.raw`$sig = Get-AuthenticodeSignature -FilePath $cd[0]; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw ('setup.exe nicht von Microsoft signiert: ' + $sig.Status) }`,
    // sa bekommt ein Einmal-Kennwort und wird danach gesperrt; angemeldet wird mit dem Lab-Login aus dem Tresor
    String.raw`$sa = 'Sa-' + [guid]::NewGuid().ToString('N') + '!9a'`,
    String.raw`$a = @('/Q', '/ACTION=Install', '/IACCEPTSQLSERVERLICENSETERMS', '/FEATURES=SQLENGINE', '/INSTANCENAME=MSSQLSERVER', '/SQLSVCACCOUNT="NT Service\MSSQLSERVER"', '/SQLSVCSTARTUPTYPE=Automatic',`,
    String.raw`  ('/SQLSYSADMINACCOUNTS="BUILTIN\Administrators" "' + $env:COMPUTERNAME + '\alfred"'), '/SECURITYMODE=SQL', ('/SAPWD="' + $sa + '"'), '/TCPENABLED=1', '/NPENABLED=0', '/UPDATEENABLED=False')`,
    String.raw`$pr = Start-Process -FilePath $cd[0] -ArgumentList $a -Wait -PassThru -NoNewWindow`,
    String.raw`$sum = @(Get-ChildItem 'C:\Program Files\Microsoft SQL Server\*\Setup Bootstrap\Log\Summary.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)`,
    String.raw`$zeilen = $(if ($sum.Count) { @(Get-Content $sum[0].FullName -TotalCount 40 | Where-Object { $_ -match '^\s*(Final result|Exit code|Exit message)' } | ForEach-Object { $_.Trim() }) } else { @() })`,
    String.raw`if ($pr.ExitCode -ne 0 -and $pr.ExitCode -ne 3010) { throw ('Setup Exit ' + $pr.ExitCode + ': ' + ($zeilen -join ' | ')) }`,
    String.raw`[ordered]@{ zustand = 'installiert'; code = $pr.ExitCode; summary = $zeilen; signiert = $sig.SignerCertificate.Subject }`,
  ];
  return lab(p, true, [
    MIT_KONTO,
    `$w = MitKonto 'SYSTEM' '' ${psText(innenSkript(p, [...LAB_WAECHTER, ...setup]))} 5400`,
    // Lab-Login über Shared Memory als alfred (sysadmin über die lokale Gruppe Administrators); sa sperren
    String.raw`$k = [string]$e.kennwort; if ($k.Length -lt 16) { throw 'Lab-Kennwort zu kurz' }`,
    String.raw`$cn = New-Object System.Data.SqlClient.SqlConnection 'Server=lpc:.;Database=master;Integrated Security=SSPI;Connect Timeout=30;Pooling=false;Application Name=Alfred-PKI-Lab'`,
    String.raw`$cn.Open(); try {`,
    String.raw`  $cmd = $cn.CreateCommand(); $cmd.Parameters.AddWithValue('@k', $k) | Out-Null`,
    String.raw`  $cmd.CommandText = "DECLARE @s nvarchar(max); IF SUSER_ID(N'" + $p.login + "') IS NULL SET @s = N'CREATE LOGIN [" + $p.login + "] WITH PASSWORD = ' + QUOTENAME(@k, '''') + N', CHECK_POLICY = ON, DEFAULT_DATABASE = master' ELSE SET @s = N'ALTER LOGIN [" + $p.login + "] WITH PASSWORD = ' + QUOTENAME(@k, '''') + N', CHECK_POLICY = ON'; EXEC (@s); ALTER LOGIN [sa] DISABLE;"`,
    // ab SQL 2022 braucht sys.dm_exec_connections (Nachweis „verschlüsselt“ im Test) VIEW SERVER PERFORMANCE STATE — auch für die eigene Sitzung
    String.raw`  $cmd.CommandText += " IF EXISTS (SELECT 1 FROM sys.fn_builtin_permissions('SERVER') WHERE permission_name = N'VIEW SERVER PERFORMANCE STATE') EXEC (N'GRANT VIEW SERVER PERFORMANCE STATE TO [" + $p.login + "]') ELSE EXEC (N'GRANT VIEW SERVER STATE TO [" + $p.login + "]');"`,
    String.raw`  [void]$cmd.ExecuteNonQuery()`,
    String.raw`  $cmd.Parameters.Clear(); $cmd.CommandText = "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) v, CAST(SERVERPROPERTY('Edition') AS nvarchar(80)) e, CAST(SERVERPROPERTY('IsHadrEnabled') AS int) h, (SELECT is_disabled FROM sys.server_principals WHERE name = N'sa') sa"`,
    String.raw`  $rd = $cmd.ExecuteReader(); [void]$rd.Read(); $info = [ordered]@{ version = [string]$rd['v']; edition = [string]$rd['e']; hadr = [int]$rd['h']; saGesperrt = [bool]$rd['sa'] }; $rd.Close()`,
    String.raw`} finally { $cn.Close() }`,
    String.raw`Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; zustand = $w.zustand; code = $w.code; summary = $w.summary; signiert = $w.signiert; login = $p.login; sql = $info })`,
  ]);
}

// ── Zertifikate für die Fälle ─────────────────────────────────────────────────────────────────────────────────────────
export type LabArt = 'gueltig' | 'selbstsigniert' | 'kurzlebig';
export interface LabAusstellen { art: LabArt; dns: string[]; minuten?: number }
export function pruefeLabAusstellen(o: Record<string, unknown>): LabAusstellen | string {
  const art = String(o.art ?? '');
  if (!['gueltig', 'selbstsigniert', 'kurzlebig'].includes(art)) return 'art: gueltig | selbstsigniert | kurzlebig';
  const dns = (Array.isArray(o.dns) ? o.dns : [o.dns]).map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean);
  if (!dns.length || dns.length > 4 || dns.some(d => !LAB_NAME.test(d))) return `dns: 1–4 Namen <x>.${LAB_SUFFIX}`;
  const r: LabAusstellen = { art: art as LabArt, dns };
  if (art === 'kurzlebig') { const m = Number(o.minuten ?? 15); if (!Number.isInteger(m) || m < 5 || m > 120) return 'minuten: 5–120 (Laufzeit des kurzlebigen Zertifikats)'; r.minuten = m; }
  return r;
}
export function labAusstellenSkript(a: LabAusstellen): string {
  return labAlsSystem({ ...a, ca_name: LAB_CA_NAME }, [
    String.raw`$dir = Join-Path $env:ProgramData 'Alfred\pkilab'; New-Item -ItemType Directory -Path $dir -Force | Out-Null`,
    String.raw`$name = 'Alfred PKI-Lab ' + $p.art + ' ' + (Get-Date -Format 'yyyyMMdd-HHmmss')`,
    String.raw`if ($p.art -eq 'selbstsigniert') {`,
    String.raw`  $c = New-SelfSignedCertificate -DnsName @($p.dns) -CertStoreLocation 'Cert:\LocalMachine\My' -KeySpec KeyExchange -Provider 'Microsoft RSA SChannel Cryptographic Provider' -KeyLength 2048 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(30) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1') -FriendlyName $name`,
    String.raw`  $t = $c.Thumbprint`,
    String.raw`} else {`,
    String.raw`  $id = [guid]::NewGuid().ToString('N').Substring(0, 8); $inf = Join-Path $dir ($id + '.inf'); $req = Join-Path $dir ($id + '.req'); $cer = Join-Path $dir ($id + '.cer')`,
    String.raw`  $z = @('[NewRequest]', ('Subject = "CN=' + $p.dns[0] + '"'), 'KeySpec = 1', 'KeyLength = 2048', 'Exportable = FALSE', 'MachineKeySet = TRUE', 'ProviderName = "Microsoft RSA SChannel Cryptographic Provider"', 'ProviderType = 12', 'RequestType = PKCS10', 'KeyUsage = 0xa0', ('FriendlyName = "' + $name + '"'), '[EnhancedKeyUsageExtension]', 'OID=1.3.6.1.5.5.7.3.1', '[Extensions]', '2.5.29.17 = "{text}"') + @($p.dns | ForEach-Object { '_continue_ = "dns=' + $_ + '&"' })`,
    String.raw`  [IO.File]::WriteAllLines($inf, $z, [Text.Encoding]::ASCII)`,
    String.raw`  try {`,
    String.raw`    $o = (& certreq.exe -new -q -machine $inf $req 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw ('certreq -new: ' + $o.Trim()) }`,
    String.raw`    $cfg = $env:COMPUTERNAME + '\' + $p.ca_name`,
    String.raw`    $at = $(if ($p.art -eq 'kurzlebig') { @('-attrib', ('ValidityPeriod:Minutes\nValidityPeriodUnits:' + $p.minuten)) } else { @() })`,
    String.raw`    $o = (& certreq.exe -submit -q -config $cfg @at $req $cer 2>&1 | Out-String); if ($LASTEXITCODE -ne 0 -or -not (Test-Path $cer)) { throw ('certreq -submit: ' + $o.Trim()) }`,
    String.raw`    $o = (& certreq.exe -accept -q -machine $cer 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw ('certreq -accept: ' + $o.Trim()) }`,
    String.raw`    $t = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer).Thumbprint`,
    String.raw`  } finally { Remove-Item -LiteralPath $inf, $req, $cer -Force -ErrorAction SilentlyContinue }`,
    String.raw`}`,
    String.raw`$c = Get-Item ('Cert:\LocalMachine\My\' + $t) -ErrorAction SilentlyContinue`,
    String.raw`if (-not $c -or -not $c.HasPrivateKey) { throw ('Zertifikat ' + $t + ' ohne privaten Schlüssel im Maschinenspeicher') }`,
    String.raw`if ($p.art -eq 'kurzlebig' -and $c.NotAfter -gt (Get-Date).AddMinutes([int]$p.minuten + 15)) { throw ('Laufzeit nicht verkürzt: gültig bis ' + $c.NotAfter.ToString('s') + ' — die CA hat ValidityPeriod aus der Anforderung nicht übernommen') }`,
    String.raw`$sans = @(($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }).Format($false) -split ',\s*' | ForEach-Object { ($_ -replace '^(DNS Name|DNS-Name)=', '').Trim().ToLower() })`,
    String.raw`[ordered]@{ rechner = $env:COMPUTERNAME; art = $p.art; thumbprint = $c.Thumbprint; seriennummer = $c.SerialNumber; subjekt = $c.Subject; aussteller = $c.Issuer; sans = $sans; von = $c.NotBefore.ToString('s'); bis = $c.NotAfter.ToString('s') }`,
  ], 600);
}

export function labSperrenSkript(p: { thumbprint: string }): string {
  return labAlsSystem({ ...p, ca_name: LAB_CA_NAME }, [
    String.raw`$c = Get-Item ('Cert:\LocalMachine\My\' + $p.thumbprint) -ErrorAction SilentlyContinue; if (-not $c) { throw ('Zertifikat ' + $p.thumbprint + ' nicht im Maschinenspeicher') }`,
    String.raw`if ($c.Issuer -ne ('CN=' + $p.ca_name)) { throw ('nur Zertifikate der Lab-CA — Aussteller ' + $c.Issuer) }`,
    String.raw`$o = (& certutil.exe -revoke $c.SerialNumber 1 2>&1 | Out-String); if ($LASTEXITCODE -ne 0 -and $o -notmatch 'already revoked|bereits gesperrt') { throw ('certutil -revoke: ' + $o.Trim()) }`,
    String.raw`$o = (& certutil.exe -crl 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw ('certutil -crl: ' + $o.Trim()) }`,
    String.raw`$crl = 'C:\inetpub\wwwroot\pki\lab.crl'; $d = (& certutil.exe -dump $crl 2>&1 | Out-String)`,
    String.raw`$drin = ($d -replace '\s', '').ToLower().Contains($c.SerialNumber.ToLower())`,
    String.raw`if (-not $drin) { throw ('Seriennummer ' + $c.SerialNumber + ' nicht in der veröffentlichten Sperrliste ' + $crl) }`,
    String.raw`$n = [regex]::Match($d, '(CRL Number|Sperrlistennummer)[^=:]*[=:]\s*([0-9a-fA-F]+)').Groups[2].Value`,
    String.raw`[ordered]@{ rechner = $env:COMPUTERNAME; thumbprint = $c.Thumbprint; seriennummer = $c.SerialNumber; crl = $crl; crlNummer = $n; gesperrt = $true }`,
  ], 300);
}

export function labCrlDienstSkript(p: { an: boolean; crl_host: string }): string {
  return lab(p, false, [
    String.raw`if ($p.an) { Set-Service W3SVC -StartupType Automatic; Start-Service W3SVC } else { Stop-Service W3SVC -Force }`,
    String.raw`Start-Sleep -Seconds 2`,
    String.raw`$url = 'http://' + $p.crl_host + '/pki/lab.crl'; $code = 0; $fehler = ''`,
    String.raw`try { $code = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10).StatusCode } catch { $fehler = [string]$_.Exception.Message }`,
    String.raw`if ($p.an -and $code -ne 200) { throw ('Sperrliste nach dem Start nicht abrufbar: ' + $url + ' ' + $fehler) }`,
    String.raw`if (-not $p.an -and $code -eq 200) { throw ('Sperrliste trotz gestopptem Webserver abrufbar: ' + $url) }`,
    String.raw`Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; webserver = [string](Get-Service W3SVC).Status; url = $url; http = $code; fehler = $fehler })`,
  ]);
}

// ── Bindung an die Lab-Instanz (ohne die Produktions-Gates — die Fälle sind absichtlich ungültig) ─────────────────────
export function labBindenSkript(p: { thumbprint: string }): string {
  return lab(p, false, [
    String.raw`$c = Get-Item ('Cert:\LocalMachine\My\' + $p.thumbprint) -ErrorAction SilentlyContinue; if (-not $c -or -not $c.HasPrivateKey) { throw ('Zertifikat ' + $p.thumbprint + ' fehlt oder ohne privaten Schlüssel') }`,
    String.raw`$id = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL' -ErrorAction Stop).MSSQLSERVER; if (-not $id) { throw 'Lab-SQL-Instanz MSSQLSERVER fehlt' }`,
    String.raw`$basis = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\' + $id + '\MSSQLServer'; $nl = $basis + '\SuperSocketNetLib'`,
    // Lesezugriff für das Dienstkonto auf den privaten Schlüssel (CAPI: MachineKeys, CNG: Keys)
    String.raw`$datei = $null; try { $u = $c.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName; $datei = Join-Path $env:ProgramData ('Microsoft\Crypto\RSA\MachineKeys\' + $u) } catch { }`,
    String.raw`if (-not $datei -or -not (Test-Path $datei)) { $u = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c).Key.UniqueName; $datei = Join-Path $env:ProgramData ('Microsoft\Crypto\Keys\' + $u) }`,
    String.raw`if (-not (Test-Path $datei)) { throw 'Schlüsseldatei nicht gefunden' }`,
    String.raw`$acl = Get-Acl $datei; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT Service\MSSQLSERVER', 'Read', 'Allow'))); Set-Acl $datei $acl`,
    String.raw`$vor = [string](Get-ItemProperty $nl).Certificate`,
    String.raw`Set-ItemProperty $nl -Name Certificate -Value $p.thumbprint.ToLower(); Set-ItemProperty $nl -Name ForceEncryption -Value 1 -Type DWord`,
    String.raw`$start = Get-Date; Restart-Service MSSQLSERVER -Force`,
    String.raw`$bis = (Get-Date).AddMinutes(3); do { Start-Sleep -Seconds 3; $s = (Get-Service MSSQLSERVER).Status } while ($s -ne 'Running' -and (Get-Date) -lt $bis)`,
    String.raw`$log = ((Get-ItemProperty ($basis + '\Parameters')).PSObject.Properties | Where-Object { $_.Name -like 'SQLArg*' -and [string]$_.Value -like '-e*' } | Select-Object -First 1).Value.Substring(2)`,
    // die Zeile zum geladenen Zertifikat steht erst nach dem Start im Fehlerprotokoll — bis 60 s warten
    String.raw`$warte = (Get-Date).AddSeconds(60); do { Start-Sleep -Seconds 3; $zeilen = @(Get-Content $log -Tail 400 -ErrorAction SilentlyContinue); $geladen = ''; foreach ($z in $zeilen) { $m = [regex]::Match($z, 'Cert Hash\(sha1\) "([0-9A-Fa-f]{40})"'); if ($m.Success) { $geladen = $m.Groups[1].Value.ToUpper() } elseif ($z -match 'self-generated certificate') { $geladen = 'SELBST-ERZEUGT' } } } while ($geladen -ne $p.thumbprint -and (Get-Date) -lt $warte)`,
    String.raw`if ($s -ne 'Running') { throw ('SQL startet mit diesem Zertifikat nicht (' + $s + '): ' + (($zeilen | Select-Object -Last 8) -join ' | ')) }`,
    String.raw`if ($geladen -ne $p.thumbprint) { throw ('SQL hat ' + $geladen + ' geladen statt ' + $p.thumbprint) }`,
    String.raw`Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; vorher = $vor; thumbprint = $p.thumbprint; geladen = $geladen; force = 1; neustart = $start.ToString('s'); bis = $c.NotAfter.ToString('s') })`,
  ]);
}

// ── Test vom Lab-Client ───────────────────────────────────────────────────────────────────────────────────────────────
export type LabFall = 'gueltig' | 'falscher_name' | 'unbekannte_ca' | 'abgelaufen' | 'gesperrt' | 'crl_unerreichbar';
export const LAB_FAELLE: LabFall[] = ['gueltig', 'falscher_name', 'unbekannte_ca', 'abgelaufen', 'gesperrt', 'crl_unerreichbar'];
export interface LabTest { ziel: string; fall: LabFall; erwarteter_thumbprint: string }
export function pruefeLabTest(o: Record<string, unknown>): LabTest | string {
  const ziel = String(o.ziel ?? '').trim().toLowerCase(); if (!LAB_NAME.test(ziel)) return `ziel: Lab-Name <x>.${LAB_SUFFIX}`;
  const fall = String(o.fall ?? '') as LabFall; if (!LAB_FAELLE.includes(fall)) return `fall: ${LAB_FAELLE.join(' | ')}`;
  const t = String(o.erwarteter_thumbprint ?? '').replace(/\s/g, '').toUpperCase(); if (!THUMB.test(t)) return 'erwarteter_thumbprint: 40 Hex (aus lab_zertifikat_ausstellen)';
  return { ziel, fall, erwarteter_thumbprint: t };
}
export interface LabBefund {
  probe: { thumbprint?: string; subjekt?: string; aussteller?: string; sans?: string[]; von?: string; bis?: string; kette?: boolean; kettenStatus?: string[]; antwortUnverschluesselt?: number; zeit: string; fehler?: string };
  anmeldung: { server?: string; verschluesselt?: boolean; fehler?: string; dmvFehler?: string };
  cacheGeleert: boolean;
  cache?: string;
}
export function labTestSkript(t: LabTest): string {
  return lab({ ...t, login: LAB_LOGIN }, true, [
    ...TDS_PROBE,
    // Sperrlisten-Zwischenspeicher leeren (nur Lab-Client), sonst prüft die Kette gegen eine alte Sperrliste
    // leerer Zwischenspeicher meldet „nicht gefunden“ — maßgeblich ist, dass danach kein Eintrag zum Lab mehr übrig ist
    String.raw`$cache = (& certutil.exe -urlcache * delete 2>&1 | Out-String); $cacheCode = $LASTEXITCODE`,
    // über SSH (ohne WinINet-Sitzung) bricht -urlcache delete mit 0x80070078 ab (Realfall 15.11.) — dann die Dateien des
    // Benutzer-Zwischenspeichers direkt löschen; die Kettenprüfung unten läuft im selben Benutzerkontext
    String.raw`$cu = Join-Path $env:USERPROFILE 'AppData\LocalLow\Microsoft\CryptnetUrlCache'`,
    String.raw`foreach ($u in @('Content', 'MetaData')) { Get-ChildItem -LiteralPath (Join-Path $cu $u) -File -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }`,
    String.raw`$uebrig = @(Get-ChildItem -LiteralPath (Join-Path $cu 'Content') -File -Force -ErrorAction SilentlyContinue).Count`,
    String.raw`$rest = (& certutil.exe -urlcache * 2>&1 | Out-String)`,
    String.raw`$geleert = ($uebrig -eq 0) -and ($rest -notmatch 'pkilab\.test')`,
    String.raw`$cacheText = ('Dateien übrig ' + $uebrig + '; certutil Exit ' + $cacheCode + ': ' +(($cache -replace '\s+', ' ').Trim())); if ($cacheText.Length -gt 300) { $cacheText = $cacheText.Substring(0, 300) }`,
    String.raw`& certutil.exe -setreg chain\ChainCacheResyncFiletime '@now' 2>&1 | Out-Null`,
    String.raw`function Sans($c) { $x = $c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }; if (-not $x) { return @() }; @(($x.Format($false) -split ',\s*') | Where-Object { $_ -match '^(DNS Name|DNS-Name)=' } | ForEach-Object { ($_ -replace '^(DNS Name|DNS-Name)=', '').Trim().ToLower() }) }`,
    String.raw`$probe = [ordered]@{ zeit = (Get-Date).ToString('s') }`,
    String.raw`try {`,
    String.raw`  $probe.antwortUnverschluesselt = [AlfredTdsProbe]::Verschluesselung($p.ziel, 1433, 0, 20000)`,
    String.raw`  $c = [AlfredTdsProbe]::Zertifikat($p.ziel, 1433, 20000)`,
    String.raw`  $ch = New-Object Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode = 'Online'; $ch.ChainPolicy.RevocationFlag = 'EntireChain'; $ch.ChainPolicy.UrlRetrievalTimeout = New-TimeSpan -Seconds 15`,
    String.raw`  [void]$ch.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid '1.3.6.1.5.5.7.3.1'))`,
    String.raw`  $probe.kette = $ch.Build($c); $probe.kettenStatus = @(@($ch.ChainStatus | ForEach-Object { [string]$_.Status }) | Select-Object -Unique)`,
    String.raw`  $probe.thumbprint = $c.Thumbprint; $probe.subjekt = $c.Subject; $probe.aussteller = $c.Issuer; $probe.sans = @(Sans $c); $probe.von = $c.NotBefore.ToString('s'); $probe.bis = $c.NotAfter.ToString('s')`,
    String.raw`} catch { $probe.fehler = ([string]$_.Exception.Message -replace '\s+', ' ') }`,
    String.raw`$anm = [ordered]@{}`,
    String.raw`try {`,
    String.raw`  $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder; $b['Data Source'] = 'tcp:' + $p.ziel + ',1433'; $b['Initial Catalog'] = 'master'; $b['User ID'] = $p.login; $b['Password'] = [string]$e.kennwort`,
    String.raw`  $b['Encrypt'] = $true; $b['TrustServerCertificate'] = $false; $b['Connect Timeout'] = 20; $b['Pooling'] = $false; $b['Application Name'] = 'Alfred-PKI-Lab'`,
    String.raw`  $cn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString; $cn.Open()`,
    // Fehler nach dem Öffnen sind keine Treiber-Ablehnung: die DMV-Abfrage hat einen eigenen Befund
    String.raw`  try { $cmd = $cn.CreateCommand(); $cmd.CommandText = 'SELECT CAST(@@SERVERNAME AS nvarchar(128))'; $anm.server = [string]$cmd.ExecuteScalar()`,
    String.raw`    try { $cmd.CommandText = 'SELECT CAST(encrypt_option AS nvarchar(10)) FROM sys.dm_exec_connections WHERE session_id = @@SPID'; $anm.verschluesselt = ([string]$cmd.ExecuteScalar() -eq 'TRUE') } catch { $anm.dmvFehler = ([string]$_.Exception.Message -replace '\s+', ' ') }`,
    String.raw`  } finally { $cn.Close() }`,
    String.raw`} catch { $anm.fehler = ([string]$_.Exception.Message -replace '\s+', ' ') }`,
    String.raw`Ergebnis ([ordered]@{ probe = $probe; anmeldung = $anm; cacheGeleert = $geleert; cache = $cacheText })`,
  ]);
}

const TREIBER_ABGELEHNT: Partial<Record<LabFall, RegExp>> = {
  falscher_name: /principal name|Prinzipalname|does not match|stimmt nicht/i,
  unbekannte_ca: /not trusted|nicht vertrauenswürdig|certificate chain|Zertifikatkette/i,
  abgelaufen: /certificate|Zertifikat|expired|abgelaufen/i,
};
/**
 * Abnahme: der Server hat das erwartete Fixture vorgelegt (sonst kein Beweis) und die Prüfung scheitert aus GENAU dem erwarteten Grund.
 * Gesperrt/Sperrliste nicht erreichbar: System.Data.SqlClient prüft keinen Widerruf — Beweis ist die Online-Kettenprüfung; ob der
 * Treiber dennoch verbunden hat, steht ausdrücklich im Ergebnis.
 */
export function bewerteLabTest(t: LabTest, b: LabBefund): { ok: boolean; ergebnis: 'LAB_TLS_OK' | 'EXPECTED_TLS_FAILURE' | 'NICHT_BEWIESEN'; grund: string; befunde: string[] } {
  const g: string[] = []; const p = b.probe; const a = b.anmeldung ?? {};
  const st = p.kettenStatus ?? [];
  if (p.fehler || !p.thumbprint) return { ok: false, ergebnis: 'NICHT_BEWIESEN', grund: '', befunde: [`TDS-Probe ohne Zertifikat (${p.fehler ?? 'keins'}) — ein Verbindungsfehler ist kein Beweis`] };
  if (p.thumbprint.toUpperCase() !== t.erwarteter_thumbprint) g.push(`vorgelegt ${p.thumbprint} statt Fixture ${t.erwarteter_thumbprint}`);
  if (!b.cacheGeleert && ['gesperrt', 'crl_unerreichbar'].includes(t.fall)) g.push(`Sperrlisten-Zwischenspeicher des Clients nicht geleert (${b.cache ?? 'ohne Ausgabe'})`);
  const imSan = (p.sans ?? []).includes(t.ziel);
  const ketteOk = !!p.kette && st.every(s => s === 'NoError');
  let grund = '';
  switch (t.fall) {
    case 'gueltig':
      if (!imSan) g.push(`${t.ziel} nicht im SAN (${(p.sans ?? []).join(',')})`);
      if (!ketteOk) g.push(`Kette/Sperrprüfung: ${st.join(', ') || 'nicht aufgebaut'}`);
      // ohne DMV-Recht: Server verlangt Verschlüsselung (Prelogin ENCRYPT_REQ auf ein ENCRYPT_OFF-Angebot) UND der Treiber hat mit
      // Encrypt=True/TrustServerCertificate=False geöffnet — dann ist die Sitzung zwingend TLS-gesichert
      const prelogin = a.verschluesselt === undefined && !!a.dmvFehler && p.antwortUnverschluesselt === 3;
      if (a.fehler) g.push(`Anmeldung: ${a.fehler}`); else if (a.verschluesselt !== true && !prelogin) g.push(`Verbindung nicht als verschlüsselt nachgewiesen${a.dmvFehler ? ` (${a.dmvFehler}; Prelogin-Antwort ${p.antwortUnverschluesselt})` : ''}`);
      return g.length ? { ok: false, ergebnis: 'NICHT_BEWIESEN', grund: '', befunde: g } : { ok: true, ergebnis: 'LAB_TLS_OK', grund: `Name im SAN, Kette und Online-Sperrprüfung ohne Befund, Anmeldung verschlüsselt (${prelogin ? 'Server erzwingt Verschlüsselung, Treiber mit Zertifikatsprüfung verbunden' : 'sys.dm_exec_connections'})`, befunde: [] };
    case 'falscher_name':
      if (imSan) g.push(`${t.ziel} steht doch im SAN`); if (!ketteOk) g.push(`Kette sollte in Ordnung sein: ${st.join(', ')}`);
      grund = `Name ${t.ziel} nicht im SAN (${(p.sans ?? []).join(',')})`; break;
    case 'unbekannte_ca':
      if (!st.some(s => s === 'UntrustedRoot' || s === 'PartialChain')) g.push(`Kettenstatus ohne UntrustedRoot/PartialChain: ${st.join(', ') || 'NoError'}`);
      grund = `nicht vertrauenswürdige Stammzertifizierungsstelle (${st.join(', ')})`; break;
    case 'abgelaufen':
      if (!st.includes('NotTimeValid')) g.push(`Kettenstatus ohne NotTimeValid: ${st.join(', ') || 'NoError'}`);
      if (p.bis && p.bis > p.zeit) g.push(`Fixture noch gültig bis ${p.bis} (Prüfung ${p.zeit})`);
      grund = `abgelaufen seit ${p.bis} (${st.join(', ')})`; break;
    case 'gesperrt':
      if (!st.includes('Revoked')) g.push(`Kettenstatus ohne Revoked: ${st.join(', ') || 'NoError'}`);
      grund = `gesperrt laut Online-Sperrliste (${st.join(', ')})`; break;
    case 'crl_unerreichbar':
      if (st.includes('Revoked')) g.push('Revoked statt „Sperrstatus unbekannt“');
      if (!st.some(s => s === 'RevocationStatusUnknown' || s === 'OfflineRevocation')) g.push(`Kettenstatus ohne RevocationStatusUnknown/OfflineRevocation: ${st.join(', ') || 'NoError'}`);
      grund = `Sperrstatus nicht prüfbar, Sperrliste nicht erreichbar (${st.join(', ')})`; break;
  }
  const muster = TREIBER_ABGELEHNT[t.fall];
  if (muster) {
    if (!a.fehler) g.push('SqlClient hat mit Encrypt=True/TrustServerCertificate=False trotzdem verbunden');
    else if (!muster.test(a.fehler)) g.push(`SqlClient scheiterte aus anderem Grund: ${a.fehler}`);
  }
  return g.length ? { ok: false, ergebnis: 'NICHT_BEWIESEN', grund, befunde: g } : { ok: true, ergebnis: 'EXPECTED_TLS_FAILURE', grund, befunde: [] };
}
export function labTestText(t: LabTest, b: LabBefund, e: ReturnType<typeof bewerteLabTest>): string {
  const p = b.probe; const a = b.anmeldung ?? {};
  const zert = p.thumbprint ? `vorgelegt ${p.thumbprint} ${p.subjekt} (Aussteller ${p.aussteller}, ${p.von} – ${p.bis}), SAN ${(p.sans ?? []).join(',')}, Kette ${p.kette ? 'ok' : 'NICHT ok'} (online: ${(p.kettenStatus ?? []).join(', ') || 'ohne Befund'})` : `Probe ohne Zertifikat: ${p.fehler}`;
  const treiber = a.fehler ? `SqlClient (Encrypt=True, TrustServerCertificate=False) abgelehnt: ${a.fehler}` : `SqlClient verbunden (${a.server}, ${a.verschluesselt === true ? 'verschlüsselt' : a.verschluesselt === false ? 'UNVERSCHLÜSSELT' : `ohne DMV-Recht, Prelogin-Antwort ${p.antwortUnverschluesselt}${p.antwortUnverschluesselt === 3 ? ' = Server erzwingt Verschlüsselung' : ''}`})${['gesperrt', 'crl_unerreichbar'].includes(t.fall) ? ' — System.Data.SqlClient prüft keinen Widerruf; maßgeblich ist die Online-Kettenprüfung' : ''}`;
  const kopfz = e.ergebnis === 'LAB_TLS_OK' ? '✅ LAB_TLS_OK' : e.ergebnis === 'EXPECTED_TLS_FAILURE' ? `✅ EXPECTED_TLS_FAILURE (${t.fall}: ${e.grund})` : `Negativtest ${t.fall} NICHT bewiesen`;
  return `${kopfz} ${t.ziel}:1433 (${p.zeit}): ${zert}; ${treiber}${e.befunde.length ? ` — BEFUNDE: ${e.befunde.join('; ')}` : ''}`;
}
