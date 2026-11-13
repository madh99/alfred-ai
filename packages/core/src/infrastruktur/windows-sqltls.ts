/**
 * PKI Etappe 3b — SQL-TLS-Zertifikate (Bau-Spec 252217f3 Pos. 11–15, Architektur f583a405):
 *   - Vorlage AD3033-SQL-TLS-v1 (Profil in windows-codesignatur.ts): nur ServerAuthentication, KU DigitalSignature+KeyEncipherment,
 *     RSA 3072/SHA256, Legacy-CSP „Microsoft RSA SChannel Cryptographic Provider“, AT_KEYEXCHANGE, nicht exportierbar, 1 Jahr,
 *     Renewal 8 Wochen, Name aus der Anforderung NUR mit CA-Freigabe; Registrieren nur die Gruppe mit SQL01$/SQL02$.
 *   - anfordern (auf dem Knoten als SYSTEM = Computerkonto): eigener Schlüssel je Knoten, CN = Knoten-FQDN, SAN = feste Allowlist;
 *     RequestId wird auf dem Knoten gemerkt (Wiederholen reicht dieselbe Anforderung nicht neu ein).
 *   - genehmigen (auf der CA): Anforderer, Vorlage, Name, Schlüssellänge und ALLE SAN gegen die Allowlist, erst dann ausstellen.
 *   - installieren (auf dem Knoten): abholen, in LocalMachine\My annehmen, Engine-gMSA Lesen auf genau diesen Schlüssel.
 *   - zertifikat_pruefen / erneuerung_status (lesend). Keine Bindung an SQL, kein Neustart (Etappe 4).
 */
import { kopf, psText } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';

export const SQL_TLS_VORLAGE = 'AD3033-SQL-TLS-v1';
export const SQL_TLS_PROVIDER = 'Microsoft RSA SChannel Cryptographic Provider';
const DNS = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FQDN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CA_KONFIG = /^[a-z0-9.-]{3,253}\\[A-Za-z0-9][A-Za-z0-9 ._-]{2,62}$/i;
const VORLAGE = /^[A-Za-z][A-Za-z0-9-]{2,39}$/;
const KONTO = /^[A-Za-z0-9-]{1,15}\\[A-Za-z0-9._-]{1,20}\$?$/;

/**
 * v1855 — Vorlagen-Erweiterung (1.3.6.1.4.1.311.21.7) zeigt Windows als „Template=<Anzeigename>(<OID>), …“: der Anzeigename hat
 * Leerzeichen statt Bindestrichen (Realfall fad4b31b: „AD3033 SQL TLS v1“). Treffer = technischer Name ODER Anzeigename, exakt.
 */
const VORLAGE_TREFFER = "$_.Oid.Value -eq '1.3.6.1.4.1.311.21.7' -and (($_.Format($false) -replace '^Template=([^(]*)\\(.*$', '$1').Trim() -in @($p.vorlage, ($p.vorlage -replace '-', ' ')))";

export interface SqlTlsAnforderung { vorlage: string; cn: string; sans: string[]; ca: string; erneuerung: boolean }
export function pruefeAnforderung(o: Record<string, unknown>): SqlTlsAnforderung | string {
  const sans = (Array.isArray(o.sans) ? o.sans : []).map(x => String(x).trim().toLowerCase());
  const r = { vorlage: String(o.vorlage ?? SQL_TLS_VORLAGE).trim(), cn: String(o.cn ?? '').trim().toLowerCase(), sans, ca: String(o.ca ?? '').trim(), erneuerung: o.erneuerung === true };
  if (!VORLAGE.test(r.vorlage)) return 'vorlage: Name der Vorlage, z. B. AD3033-SQL-TLS-v1';
  if (!FQDN.test(r.cn)) return 'cn: FQDN des eigenen Knotens, z. B. sql01.ad.3033.at';
  if (!sans.length || sans.length > 12 || sans.some(x => !DNS.test(x)) || new Set(sans).size !== sans.length) return 'sans: 1–12 verschiedene DNS-Namen (keine Wildcards, keine IP), z. B. [sql01.ad.3033.at, sql02.ad.3033.at, sqlag01.ad.3033.at, sql01, sql02, sqlag01]';
  if (!sans.includes(r.cn)) return 'sans: der eigene Knoten-FQDN (cn) muss enthalten sein';
  if (!CA_KONFIG.test(r.ca)) return 'ca: CA-Konfiguration „<CA-Host-FQDN>\\<CA-Name>“, z. B. pkiiss01.ad.3033.at\\AD3033 Issuing CA 01';
  return r;
}

/** INF für certreq -new (Spec Pos. 11): Maschinenschlüssel, nicht exportierbar, SChannel-CSP, AT_KEYEXCHANGE, SAN als eine Zeile */
export function anforderungInf(a: { vorlage: string; cn: string; sans: string[] }): string {
  return [
    '[Version]', 'Signature="$Windows NT$"', '',
    '[NewRequest]', `Subject = "CN=${a.cn}"`, 'KeyLength = 3072', 'KeySpec = 1', 'Exportable = FALSE', 'MachineKeySet = TRUE',
    `ProviderName = "${SQL_TLS_PROVIDER}"`, 'ProviderType = 12', 'HashAlgorithm = sha256', 'RequestType = PKCS10', 'KeyUsage = 0xa0', 'SMIME = FALSE', '',
    '[EnhancedKeyUsageExtension]', 'OID=1.3.6.1.5.5.7.3.1', '',
    '[Extensions]', `2.5.29.17 = "{text}${a.sans.map(s => `dns=${s}`).join('&')}"`, '',
    // v1854 — keine [RequestAttributes]: certreq -new prüfte die Vorlage gegen den lokalen Richtlinien-Zwischenspeicher („Machine
    // context template conflicts“); die Vorlage kommt beim Einreichen über -attrib dazu, die CA prüft sie.
  ].join('\r\n');
}

/**
 * Auf dem SQL-Knoten als SYSTEM (Computerkonto, Kerberos-Ticket vorher erneuert — die Gruppenmitgliedschaft ist frisch): Schlüssel und
 * Anforderung erzeugen, einreichen. Wiederholbar über die gemerkte Anforderung; ein gültiges Zertifikat der Vorlage gilt als vorhanden
 * (nur mit erneuerung wird zusätzlich angefordert — das alte bleibt unverändert, Spec Pos. 15).
 */
export function anfordernSkript(a: SqlTlsAnforderung): string {
  const innen = innenSkript({ ...a, inf: anforderungInf(a) }, [
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$merk = Join-Path $dir 'sqltls-anforderung.json'",
    "$sanText = ($p.sans | Sort-Object) -join ','",
    "if (Test-Path -LiteralPath $merk) { $m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json; if ($m.vorlage -eq $p.vorlage -and $m.cn -eq $p.cn -and $m.sans -eq $sanText -and -not $m.installiert) { return [ordered]@{ zustand = 'schon angefordert'; requestId = [int]$m.requestId; cn = $p.cn; sans = $sanText; zeit = $m.zeit } } }",
    // ein gültiges Zertifikat dieser Vorlage (Name im Zertifikat) für diesen Knoten gilt als vorhanden
    `$vorh = @(Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Subject -eq ('CN=' + $p.cn) -and $_.NotAfter -gt (Get-Date) -and ($_.Extensions | Where-Object { ${VORLAGE_TREFFER} }) })`,
    "if ($vorh.Count -and -not $p.erneuerung) { return [ordered]@{ zustand = 'schon vorhanden'; requestId = 0; cn = $p.cn; sans = $sanText; thumbprint = $vorh[0].Thumbprint; gueltigBis = $vorh[0].NotAfter.ToString('s') } }",
    "$inf = Join-Path $dir 'sqltls.inf'; $req = Join-Path $dir 'sqltls.req'; $cer = Join-Path $dir 'sqltls-sofort.cer'",
    "[IO.File]::WriteAllText($inf, [string]$p.inf, [Text.Encoding]::ASCII)",
    "Remove-Item -LiteralPath $req, $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    // frisches Computer-Ticket: die Mitgliedschaft in der Registrier-Gruppe wirkt erst im neuen Ticket
    "$null = & klist.exe -li 0x3e7 purge",
    "$n = (& certreq.exe -new -q -f $inf $req) -join ' '; if (-not (Test-Path -LiteralPath $req)) { throw ('certreq -new: ' + $n) }",
    "$s = (& certreq.exe -submit -q -f -config $p.ca -attrib ('CertificateTemplate:' + $p.vorlage) $req $cer) -join ' '",
    "$id = [regex]::Match($s, 'RequestId:\\s*\"?(\\d+)').Groups[1].Value",
    "if (-not $id) { throw ('certreq -submit: ' + $s) }",
    "$shaF = [Security.Cryptography.SHA256]::Create(); $t = [IO.File]::ReadAllText($req) -replace '-----[^-]+-----', '' -replace '\\s', ''",
    "$sha = (($shaF.ComputeHash([Convert]::FromBase64String($t))) | ForEach-Object { $_.ToString('x2') }) -join ''",
    "$m = [ordered]@{ requestId = [int]$id; vorlage = $p.vorlage; cn = $p.cn; sans = $sanText; csrSha256 = $sha; zeit = (Get-Date).ToString('s'); installiert = $false }",
    "[IO.File]::WriteAllText($merk, ($m | ConvertTo-Json -Compress))",
    "Remove-Item -LiteralPath $inf, $req, $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "[ordered]@{ zustand = 'angefordert'; requestId = [int]$id; cn = $p.cn; sans = $sanText; csrSha256 = $sha; antwort = ($s -replace '\\s+', ' ').Substring(0, [Math]::Min(200, $s.Length)) }",
  ]);
  return alsSystem(a, innen, 300);
}

export interface Genehmigung { request_id: number; cn: string; sans: string[]; vorlage: string; schluessel_bits: number }
export function pruefeGenehmigung(o: Record<string, unknown>): Genehmigung | string {
  const sans = (Array.isArray(o.sans) ? o.sans : []).map(x => String(x).trim().toLowerCase());
  const r = { request_id: Number(o.request_id), cn: String(o.cn ?? '').trim().toLowerCase(), sans, vorlage: String(o.vorlage ?? SQL_TLS_VORLAGE).trim(), schluessel_bits: o.schluessel_bits === undefined ? 3072 : Number(o.schluessel_bits) };
  if (!Number.isInteger(r.request_id) || r.request_id < 1) return 'request_id: RequestId aus sql_tls_anfordern';
  if (!FQDN.test(r.cn)) return 'cn: erwarteter Knoten-FQDN';
  if (!sans.length || sans.some(x => !DNS.test(x))) return 'sans: Allowlist der DNS-Namen';
  if (!VORLAGE.test(r.vorlage)) return 'vorlage: Name der Vorlage';
  if (![3072, 4096].includes(r.schluessel_bits)) return 'schluessel_bits: 3072 oder 4096';
  return r;
}

/**
 * Auf der CA als SYSTEM (CA-Verwalter): die ausstehende Anforderung über die CA-Datenbank (ICertView) lesen und vollständig prüfen —
 * Status ausstehend, Anforderer = Computerkonto des Knotens aus cn, Vorlage, Subject, Schlüssellänge, nur DNS-SAN und genau die
 * Allowlist — erst dann ausstellen (resubmit). Schon ausgestellt mit passenden Angaben: wiederholbar ohne erneutes Ausstellen.
 */
export function genehmigenSkript(g: Genehmigung): string {
  const innen = innenSkript(g, [
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$ca = [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active; if (-not $ca) { throw 'auf diesem Rechner läuft keine CA' }",
    "$konfig = [Net.Dns]::GetHostEntry('').HostName + '\\' + $ca",
    "$v = New-Object -ComObject CertificateAuthority.View; $v.OpenConnection($konfig)",
    "$spalten = @('RequestID', 'Request.RequesterName', 'Request.Disposition', 'Request.RawRequest', 'Request.RequestAttributes', 'SerialNumber')",
    '$v.SetResultColumnCount($spalten.Count); foreach ($s in $spalten) { $v.SetResultColumn($v.GetColumnIndex($false, $s)) }',
    "$v.SetRestriction($v.GetColumnIndex($false, 'RequestID'), 1, 0, [int]$p.request_id)",
    '$zeilen = $v.OpenView(); $w = @{}; $treffer = 0',
    'while ($zeilen.Next() -ne -1) { $treffer++; $sp = $zeilen.EnumCertViewColumn(); while ($sp.Next() -ne -1) { $w[$sp.GetName()] = $sp.GetValue(1) } }',
    "if ($treffer -ne 1) { throw ('Anforderung ' + $p.request_id + ' nicht eindeutig in der CA-Datenbank (' + $treffer + ')') }",
    "$disp = [int]$w['Request.Disposition']",
    "$attr = [string]$w['Request.RequestAttributes']",
    "$wer = [string]$w['Request.RequesterName']",
    "$host1 = ($p.cn -split '\\.')[0].ToUpper()",
    "$r = New-Object -ComObject X509Enrollment.CX509CertificateRequestPkcs10; $r.InitializeDecode(([string]$w['Request.RawRequest'] -replace '\\s', ''), 1)",
    '$subjekt = [string]$r.Subject.Name; $bits = [int]$r.PublicKey.Length',
    '$sans = @(); $andere = @()',
    "foreach ($x in $r.X509Extensions) { if ($x.ObjectId.Value -eq '2.5.29.17') { $an = New-Object -ComObject X509Enrollment.CX509ExtensionAlternativeNames; $an.InitializeDecode(1, $x.RawData(1)); foreach ($n in $an.AlternativeNames) { if ($n.Type -eq 3) { $sans += ([string]$n.strValue).ToLower() } else { $andere += ('Typ ' + $n.Type) } } } }",
    '$gruende = @()',
    "if ($disp -ne 9 -and $disp -ne 20) { $gruende += ('Status ' + $disp + ' (weder ausstehend noch ausgestellt)') }",
    "if ($wer -notmatch ('\\\\' + [regex]::Escape($host1) + '\\$$')) { $gruende += ('Anforderer ' + $wer + ' ist nicht das Computerkonto ' + $host1 + '$') }",
    "if ($attr -notmatch ('CertificateTemplate:\\s*' + [regex]::Escape($p.vorlage) + '(\\s|$)')) { $gruende += ('Vorlage nicht ' + $p.vorlage + ' (' + ($attr -replace '\\s+', ' ') + ')') }",
    "if ($subjekt -ne ('CN=' + $p.cn)) { $gruende += ('Subject ' + $subjekt + ' statt CN=' + $p.cn) }",
    "if ($bits -lt [int]$p.schluessel_bits) { $gruende += ('Schlüssel ' + $bits + ' Bit') }",
    "if ($andere.Count) { $gruende += ('SAN außer DNS: ' + ($andere -join ', ')) }",
    "$soll = @($p.sans | Sort-Object); $ist = @($sans | Sort-Object)",
    "if (($soll -join ',') -ne ($ist -join ',')) { $gruende += ('SAN ' + ($ist -join ',') + ' statt Allowlist ' + ($soll -join ',')) }",
    "if ($gruende.Count) { throw ('Anforderung ' + $p.request_id + ' NICHT genehmigt: ' + ($gruende -join '; ')) }",
    "$zustand = 'schon ausgestellt'",
    "if ($disp -eq 9) { $f = (& certutil.exe -config $konfig -resubmit $p.request_id) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('certutil -resubmit: ' + $f) }; $zustand = 'genehmigt' }",
    "[ordered]@{ zustand = $zustand; requestId = [int]$p.request_id; anforderer = $wer; subjekt = $subjekt; sans = ($ist -join ','); bits = $bits; vorher = $disp }",
  ]);
  return alsSystem(g, innen, 300);
}

export interface Installation { request_id: number; ca: string; cn: string; dienstkonto: string }
export function pruefeInstallation(o: Record<string, unknown>): Installation | string {
  const r = { request_id: Number(o.request_id), ca: String(o.ca ?? '').trim(), cn: String(o.cn ?? '').trim().toLowerCase(), dienstkonto: String(o.dienstkonto ?? '').trim() };
  if (!Number.isInteger(r.request_id) || r.request_id < 1) return 'request_id: RequestId aus sql_tls_anfordern';
  if (!CA_KONFIG.test(r.ca)) return 'ca: CA-Konfiguration „<CA-Host-FQDN>\\<CA-Name>“';
  if (!FQDN.test(r.cn)) return 'cn: Knoten-FQDN';
  if (!KONTO.test(r.dienstkonto)) return 'dienstkonto: Engine-Konto „DOMÄNE\\name$“, z. B. AD3033\\gmsa-sqleng$';
  return r;
}

/** Auf dem Knoten als SYSTEM: abholen, in LocalMachine\My annehmen (zum wartenden Schlüssel), Engine-Konto Lesen auf genau diesen Schlüssel */
export function installierenSkript(i: Installation): string {
  const innen = innenSkript(i, [
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; $merk = Join-Path $dir 'sqltls-anforderung.json'",
    "$cer = Join-Path $dir ('sqltls-' + $p.request_id + '.cer')",
    "Remove-Item -LiteralPath $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "$g = (& certreq.exe -retrieve -f -q -config $p.ca $p.request_id $cer) -join ' '; if (-not (Test-Path -LiteralPath $cer)) { throw ('certreq -retrieve ' + $p.request_id + ': ' + $g) }",
    "$x = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer; $tp = $x.Thumbprint",
    "if ($x.Subject -ne ('CN=' + $p.cn)) { throw ('abgeholtes Zertifikat ' + $x.Subject + ' statt CN=' + $p.cn) }",
    "$zustand = 'schon installiert'",
    "if (-not (Test-Path ('Cert:\\LocalMachine\\My\\' + $tp))) { $a = (& certreq.exe -accept -q -machine $cer) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('certreq -accept: ' + $a) }; $zustand = 'installiert' }",
    "$c = Get-Item ('Cert:\\LocalMachine\\My\\' + $tp)",
    "if (-not $c.HasPrivateKey) { throw 'Zertifikat ohne privaten Schlüssel im Speicher (wartender Schlüssel fehlt?)' }",
    "$kn = $c.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName",
    "$kf = Join-Path $env:ProgramData ('Microsoft\\Crypto\\RSA\\MachineKeys\\' + $kn); if (-not (Test-Path -LiteralPath $kf)) { throw ('Schlüsseldatei fehlt: ' + $kf) }",
    "$konto = New-Object Security.Principal.NTAccount($p.dienstkonto); $sid = $konto.Translate([Security.Principal.SecurityIdentifier])",
    "$acl = Get-Acl -LiteralPath $kf",
    "$hat = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read })",
    "if (-not $hat.Count) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))); Set-Acl -LiteralPath $kf -AclObject $acl }",
    "$rechte = @((Get-Acl -LiteralPath $kf).Access | ForEach-Object { [string]$_.IdentityReference + ':' + [string]$_.FileSystemRights })",
    "if (Test-Path -LiteralPath $merk) { $m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json; if ([int]$m.requestId -eq [int]$p.request_id) { $m.installiert = $true; [IO.File]::WriteAllText($merk, ($m | ConvertTo-Json -Compress)) } }",
    "Remove-Item -LiteralPath $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "[ordered]@{ zustand = $zustand; thumbprint = $tp; subjekt = $c.Subject; gueltigBis = $c.NotAfter.ToString('s'); schluessel = $kn; schluesselRechte = $rechte }",
  ]);
  return alsSystem(i, innen, 300);
}

/** Lesend (Spec Pos. 13): alles, was CERT_VALID braucht; die Bewertung macht bewerteZertifikat */
export function zertifikatPruefenSkript(z: { thumbprint: string }): string {
  return [
    ...kopf(z, false),
    "$c = Get-Item ('Cert:\\LocalMachine\\My\\' + $p.thumbprint) -ErrorAction SilentlyContinue",
    "if (-not $c) { Ergebnis ([ordered]@{ gefunden = $false; rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s') }); return }",
    "$san = @(); $ext = $c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }; if ($ext) { $san = @(($ext.Format($false) -split ',\\s*') | ForEach-Object { ($_ -replace '^(DNS Name|DNS-Name)=', '').Trim().ToLower() }) }",
    "$eku = @(($c.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }).EnhancedKeyUsages | ForEach-Object { $_.Value })",
    "$ku = [string](($c.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509KeyUsageExtension] }).KeyUsages)",
    "$cdp = [string](($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.31' }) | ForEach-Object { $_.Format($false) })",
    "$prov = ''; $spec = ''; $exp = $null; $bits = 0; $kerr = ''",
    "try { $ki = $c.PrivateKey.CspKeyContainerInfo; $prov = $ki.ProviderName; $spec = [string]$ki.KeyNumber; $exp = $ki.Exportable } catch { $kerr = $_.Exception.Message }",
    "try { $bits = $c.PublicKey.Key.KeySize } catch {}",
    "$ch = New-Object Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode = 'Online'; $ch.ChainPolicy.RevocationFlag = 'EntireChain'; $ch.ChainPolicy.UrlRetrievalTimeout = New-TimeSpan -Seconds 30",
    "$kette = $ch.Build($c)",
    "$status = @($ch.ChainStatus | ForEach-Object { [string]$_.Status })",
    "$glieder = @($ch.ChainElements | ForEach-Object { $_.Certificate.Subject })",
    "Ergebnis ([ordered]@{ gefunden = $true; rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s'); subjekt = $c.Subject; sans = $san; eku = $eku; ku = $ku; anbieter = $prov; keySpec = $spec; exportierbar = $exp; bits = $bits; privat = $c.HasPrivateKey; schluesselFehler = $kerr; von = $c.NotBefore.ToString('s'); bis = $c.NotAfter.ToString('s'); kette = $kette; kettenStatus = $status; glieder = $glieder; cdp = $cdp })",
  ].join('\n');
}

export interface ZertifikatErwartung { subjekt: string; sans: string[]; eku: string; anbieter: string; keySpec: string; bits: number }
export interface ZertifikatBefund { gefunden: boolean; rechner: string; zeit: string; subjekt?: string; sans?: string[]; eku?: string[]; ku?: string; anbieter?: string; keySpec?: string; exportierbar?: boolean | null; bits?: number; privat?: boolean; schluesselFehler?: string; von?: string; bis?: string; kette?: boolean; kettenStatus?: string[]; glieder?: string[]; cdp?: string }
/** Spec Pos. 13: keine Fehler tolerieren, unbekannt/offline ist kein OK */
export function bewerteZertifikat(b: ZertifikatBefund, e: ZertifikatErwartung, jetzt = new Date()): { ok: boolean; gruende: string[] } {
  const g: string[] = [];
  if (!b.gefunden) return { ok: false, gruende: ['Zertifikat nicht in LocalMachine\\My'] };
  if (b.subjekt !== e.subjekt) g.push(`Subject ${b.subjekt} statt ${e.subjekt}`);
  const soll = [...e.sans].map(x => x.toLowerCase()).sort().join(','); const ist = [...(b.sans ?? [])].sort().join(',');
  if (soll !== ist) g.push(`SAN ${ist} statt ${soll}`);
  if ((b.eku ?? []).join(',') !== e.eku) g.push(`EKU ${(b.eku ?? []).join(',') || 'keine'} statt nur ${e.eku}`);
  if (!/DigitalSignature/.test(b.ku ?? '') || !/KeyEncipherment/.test(b.ku ?? '') || (b.ku ?? '').split(',').length !== 2) g.push(`KeyUsage ${b.ku || 'keine'} statt DigitalSignature, KeyEncipherment`);
  if (!b.privat) g.push('privater Schlüssel fehlt');
  if (b.anbieter !== e.anbieter) g.push(`Anbieter ${b.anbieter || b.schluesselFehler || '?'} statt ${e.anbieter}`);
  if (b.keySpec !== e.keySpec) g.push(`KeySpec ${b.keySpec || '?'} statt ${e.keySpec}`);
  if (b.exportierbar !== false) g.push(`Schlüssel exportierbar: ${String(b.exportierbar)}`);
  if (b.bits !== e.bits) g.push(`Schlüssel ${b.bits} Bit statt ${e.bits}`);
  const von = b.von ? new Date(b.von) : undefined; const bis = b.bis ? new Date(b.bis) : undefined;
  if (!von || !bis || von > jetzt || bis <= jetzt) g.push(`Laufzeit ${b.von} – ${b.bis} nicht gültig`);
  if (!b.kette || (b.kettenStatus ?? []).some(s => s !== 'NoError')) g.push(`Kette/Sperrprüfung: ${(b.kettenStatus ?? []).join(', ') || (b.kette ? '' : 'nicht aufgebaut')}`);
  if (!b.cdp) g.push('keine CRL-Verteilpunkte');
  return { ok: g.length === 0, gruende: g };
}

/** Lesend (Spec Pos. 15): Zertifikate der Vorlage auf dem Knoten mit Restlaufzeit */
export function erneuerungStatusSkript(e: { vorlage: string }): string {
  return [
    ...kopf(e, false),
    `$z = @(Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Extensions | Where-Object { ${VORLAGE_TREFFER} } } | Sort-Object NotAfter -Descending | ForEach-Object { [ordered]@{ thumbprint = $_.Thumbprint; subjekt = $_.Subject; bis = $_.NotAfter.ToString('s'); tage = [int][Math]::Floor(($_.NotAfter - (Get-Date)).TotalDays) } })`,
    "$merk = Join-Path $env:ProgramData 'Alfred\\pki\\sqltls-anforderung.json'; $offen = $null",
    "if (Test-Path -LiteralPath $merk) { $m = [IO.File]::ReadAllText($merk) | ConvertFrom-Json; if (-not $m.installiert) { $offen = [int]$m.requestId } }",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s'); zertifikate = $z; offeneAnforderung = $offen })",
  ].join('\n');
}

/** Warnstufe nach Spec (90/60/30/14 Tage); Erneuerungsfenster 8 Wochen */
export function warnstufe(tage: number, schwellen = [90, 60, 30, 14]): number | null {
  const s = [...schwellen].sort((a, b) => a - b).find(x => tage <= x);
  return s ?? null;
}

function alsSystem(p: unknown, innen: string, sekunden: number): string {
  return [
    ...kopf(p, false),
    MIT_KONTO,
    `$w = MitKonto 'SYSTEM' '' ${psText(innen)} ${sekunden}`,
    'Ergebnis $w',
  ].join('\n');
}

// ── v1856 — ungesendete Anforderungen im Speicher LocalMachine\REQUEST (Spec Pos. 12: offenen, unsignierten Request abbrechen) ─────

/** gemeinsame Teile: öffentlicher Schlüssel als SHA-256, Schlüsselcontainer, Abgleich mit LocalMachine\My */
const REQUEST_VOR = [
  "function PkHash($c) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($c.PublicKey.EncodedKeyValue.RawData) | ForEach-Object { $_.ToString('x2') }) }",
  "function Container($c) { try { $k = $c.PrivateKey.CspKeyContainerInfo; [ordered]@{ name = [string]$k.KeyContainerName; datei = [string]$k.UniqueKeyContainerName; anbieter = [string]$k.ProviderName; typ = [int]$k.ProviderType } } catch { $null } }",
  "$my = @(Get-ChildItem Cert:\\LocalMachine\\My | ForEach-Object { [ordered]@{ thumbprint = $_.Thumbprint; pk = (PkHash $_); datei = $(if ($_.HasPrivateKey) { [string](Container $_).datei } else { '' }) } })",
];

/** Lesend: alle Einträge in LocalMachine\REQUEST mit Schlüssel und ob ein Zertifikat in My denselben Schlüssel benutzt */
export function anforderungListeSkript(): string {
  return [
    ...kopf({}, false), ...REQUEST_VOR,
    "$l = @(Get-ChildItem Cert:\\LocalMachine\\REQUEST | ForEach-Object { $pk = PkHash $_; $k = $(if ($_.HasPrivateKey) { Container $_ } else { $null }); $mit = @($my | Where-Object { $_.pk -eq $pk -or ($k -and $k.datei -and $_.datei -eq $k.datei) } | ForEach-Object { $_.thumbprint }); [ordered]@{ thumbprint = $_.Thumbprint; subjekt = $_.Subject; notBefore = $_.NotBefore.ToString('s'); privat = $_.HasPrivateKey; anbieter = $(if ($k) { $k.anbieter } else { '' }); schluesselDatei = $(if ($k) { $k.datei } else { '' }); inMy = $mit } })",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s'); anforderungen = $l })",
  ].join('\n');
}

/**
 * Genau EINE ungesendete Anforderung samt privatem Schlüssel entfernen — nur wenn kein Zertifikat in LocalMachine\My denselben
 * öffentlichen Schlüssel oder dieselbe Schlüsseldatei benutzt, und nur Legacy-CSP-Schlüssel (so erzeugt sql_tls_anfordern sie).
 */
export function anforderungEntfernenSkript(a: { thumbprint: string; subjekt: string }): string {
  return [
    ...kopf(a, false), ...REQUEST_VOR,
    "$c = Get-Item ('Cert:\\LocalMachine\\REQUEST\\' + $p.thumbprint) -ErrorAction SilentlyContinue",
    "if (-not $c) { Ergebnis ([ordered]@{ zustand = 'schon entfernt'; thumbprint = $p.thumbprint; rechner = $env:COMPUTERNAME }); exit 0 }",
    "if ($c.Subject -ne $p.subjekt) { throw ('Anforderung ' + $p.thumbprint + ' hat Subject ' + $c.Subject + ' statt ' + $p.subjekt) }",
    '$pk = PkHash $c; $k = $(if ($c.HasPrivateKey) { Container $c } else { $null })',
    "$mit = @($my | Where-Object { $_.pk -eq $pk -or ($k -and $k.datei -and $_.datei -eq $k.datei) })",
    "if ($mit.Count) { throw ('Schlüssel wird von Zertifikat ' + (($mit | ForEach-Object { $_.thumbprint }) -join ', ') + ' in LocalMachine\\My benutzt — nicht entfernt') }",
    "$datei = ''; $dateiWeg = $null",
    'if ($k) {',
    "  if ($k.typ -ne 1 -and $k.typ -ne 12 -and $k.typ -ne 24) { throw ('Schlüssel von ' + $k.anbieter + ' (Typ ' + $k.typ + ') — nur Legacy-CSP unterstützt') }",
    "  $datei = Join-Path $env:ProgramData ('Microsoft\\Crypto\\RSA\\MachineKeys\\' + $k.datei)",
    '  $cp = New-Object Security.Cryptography.CspParameters($k.typ, $k.anbieter, $k.name)',
    '  $cp.Flags = [Security.Cryptography.CspProviderFlags]::UseMachineKeyStore -bor [Security.Cryptography.CspProviderFlags]::UseExistingKey',
    '  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider($cp); $rsa.PersistKeyInCsp = $false; $rsa.Clear()',
    '  $dateiWeg = -not (Test-Path -LiteralPath $datei)',
    '}',
    "$st = New-Object Security.Cryptography.X509Certificates.X509Store('REQUEST', 'LocalMachine'); $st.Open('ReadWrite'); try { $st.Remove($c) } finally { $st.Close() }",
    "if (Test-Path ('Cert:\\LocalMachine\\REQUEST\\' + $p.thumbprint)) { throw 'Anforderung nach dem Entfernen noch im Speicher' }",
    "if ($k -and -not $dateiWeg) { throw ('Schlüsseldatei nach dem Entfernen noch vorhanden: ' + $datei) }",
    "$rest = @($my | ForEach-Object { $_.thumbprint } | Where-Object { Test-Path ('Cert:\\LocalMachine\\My\\' + $_) })",
    "Ergebnis ([ordered]@{ zustand = 'entfernt'; thumbprint = $p.thumbprint; subjekt = $c.Subject; rechner = $env:COMPUTERNAME; schluesselDatei = $(if ($k) { $k.datei } else { '' }); schluesselEntfernt = [bool]$dateiWeg; myVorher = $my.Count; myNachher = $rest.Count })",
  ].join('\n');
}
