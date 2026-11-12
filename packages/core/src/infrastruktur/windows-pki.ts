/**
 * Vorhaben 3bb8c058 — eigene PKI (Offline-Root + Enterprise-Issuing-CA) über feste PowerShell-Bausteine.
 * Online-CAs (Domänenmitglied) über den Windows-Fernzugang (SSH), die netzlose Offline-Root über den QEMU-Gastagenten von Proxmox.
 * v1810: nur der lesende Status (Spec-Position 1); die ändernden Bausteine folgen in Etappe 2.
 */
import { kopf, psText, kontoAusdruck } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';

/** CA-Status: Rolle, CA-Typ und -Name, Zertifikat (Kette, pathLen, Laufzeit), CDP/AIA, CRL-Fristen, Domäne/Workgroup, Netzwerkkarten */
export function pkiStatusSkript(): string {
  return [
    ...kopf({}, false),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "$r = [ordered]@{ rechner = $env:COMPUTERNAME; domaene = $(if ($cs.PartOfDomain) { [string]$cs.Domain } else { '' }); workgroup = $(if (-not $cs.PartOfDomain) { [string]$cs.Workgroup } else { '' }); netzwerkkarten = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter 'PhysicalAdapter=TRUE' | ForEach-Object { [string]$_.Name }); jetzt = (Get-Date).ToString('s') }",
    "$f = Get-WindowsFeature -Name ADCS-Cert-Authority -ErrorAction SilentlyContinue; $r.feature = [bool]($f -and $f.Installed)",
    "$svc = Get-Service -Name CertSvc -ErrorAction SilentlyContinue; $r.dienst = $(if ($svc) { [string]$svc.Status } else { 'fehlt' })",
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })",
    "if (-not $aktiv) { $r.ca = $null; $r.zustand = $(if ($r.feature) { 'Rolle installiert, keine CA eingerichtet' } else { 'keine CA' }); Ergebnis $r; exit 0 }",
    "$c = Get-ItemProperty (Join-Path $k $aktiv)",
    "$typ = @{ 0 = 'EnterpriseRoot'; 1 = 'EnterpriseSubordinate'; 3 = 'StandaloneRoot'; 4 = 'StandaloneSubordinate' }[[int]$c.CAType]",
    "$ca = [ordered]@{ name = $aktiv; typ = $typ; crlPeriode = ([string]$c.CRLPeriodUnits + ' ' + [string]$c.CRLPeriod); crlUeberlappung = ([string]$c.CRLOverlapUnits + ' ' + [string]$c.CRLOverlapPeriod); deltaCrl = ([string]$c.CRLDeltaPeriodUnits + ' ' + [string]$c.CRLDeltaPeriod); gueltigkeitAusgestellt = ([string]$c.ValidityPeriodUnits + ' ' + [string]$c.ValidityPeriod); cdp = @($c.CRLPublicationURLs | ForEach-Object { [string]$_ }); aia = @($c.CACertPublicationURLs | ForEach-Object { [string]$_ }) }",
    "$h = @($c.CACertHash | ForEach-Object { ([string]$_) -replace '\\s', '' }) | Select-Object -Last 1",
    "$z = $(if ($h) { Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Thumbprint -eq $h } | Select-Object -First 1 })",
    'if ($z) {',
    "  $bc = $z.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1",
    "  $pl = $(if ($bc) { $b = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]$bc; if ($b.HasPathLengthConstraint) { $b.PathLengthConstraint } else { 'ohne' } } else { 'keine' })",
    "  $kette = New-Object System.Security.Cryptography.X509Certificates.X509Chain; $kette.ChainPolicy.RevocationMode = 'NoCheck'; $gueltig = $kette.Build($z)",
    "  $ca.zertifikat = [ordered]@{ thumbprint = $z.Thumbprint; subject = $z.Subject; aussteller = $z.Issuer; von = $z.NotBefore.ToString('s'); bis = $z.NotAfter.ToString('s'); schluessel = ([string]$z.PublicKey.Oid.FriendlyName + ' ' + [string]$z.PublicKey.Key.KeySize); signatur = [string]$z.SignatureAlgorithm.FriendlyName; pathLen = [string]$pl; kette = @($kette.ChainElements | ForEach-Object { $_.Certificate.Subject }); ketteOk = $gueltig; privaterSchluessel = $z.HasPrivateKey }",
    '}',
    "$crl = @(Get-ChildItem (Join-Path $env:SystemRoot 'System32\\CertSrv\\CertEnroll') -Filter *.crl -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { [ordered]@{ datei = $_.Name; geschrieben = $_.LastWriteTime.ToString('s') } })",
    "$ca.crlDateien = $crl; $r.ca = $ca; $r.zustand = $(if ($r.dienst -eq 'Running') { 'CA läuft' } else { 'CA eingerichtet, Dienst ' + $r.dienst })",
    'Ergebnis $r',
  ].join('\n');
}

export interface PkiStatus {
  rechner: string; domaene: string; workgroup: string; netzwerkkarten: string[]; jetzt: string; feature: boolean; dienst: string; zustand: string;
  ca: null | { name: string; typ: string; crlPeriode: string; crlUeberlappung: string; deltaCrl: string; gueltigkeitAusgestellt: string; cdp: string[]; aia: string[]; crlDateien: { datei: string; geschrieben: string }[];
    zertifikat?: { thumbprint: string; subject: string; aussteller: string; von: string; bis: string; schluessel: string; signatur: string; pathLen: string; kette: string[]; ketteOk: boolean; privaterSchluessel: boolean } };
}

export function pkiStatusText(s: PkiStatus, weg: 'ssh' | 'gastagent'): string {
  const ort = s.domaene ? `Domäne ${s.domaene}` : `Workgroup ${s.workgroup || '?'}`;
  const nics = s.netzwerkkarten.length ? `${s.netzwerkkarten.length} Netzwerkkarte(n)` : 'keine Netzwerkkarte';
  const kopfz = `${s.rechner} (${ort}, ${nics}, über ${weg === 'gastagent' ? 'Gastagent' : 'SSH'}, ${s.jetzt}): ${s.zustand}`;
  if (!s.ca) return `${kopfz}; Rolle ADCS-Cert-Authority ${s.feature ? 'installiert' : 'nicht installiert'}`;
  const z = s.ca.zertifikat;
  return [
    `PKI_STATUS_OK ${kopfz}`,
    `CA „${s.ca.name}“ ${s.ca.typ}, Dienst ${s.dienst}`,
    z ? `Zertifikat ${z.subject} von ${z.aussteller}, ${z.schluessel}, ${z.signatur}, pathLen ${z.pathLen}, ${z.von} – ${z.bis}, Kette ${z.ketteOk ? 'ok' : 'NICHT ok'} (${z.kette.length} Glieder), privater Schlüssel ${z.privaterSchluessel ? 'vorhanden' : 'FEHLT'}, Thumbprint ${z.thumbprint}` : 'CA-Zertifikat nicht gefunden',
    `CRL ${s.ca.crlPeriode} (Überlappung ${s.ca.crlUeberlappung}, Delta ${s.ca.deltaCrl}); ausgestellte Zertifikate höchstens ${s.ca.gueltigkeitAusgestellt}`,
    `CDP: ${s.ca.cdp.join(' | ') || '—'}`,
    `AIA: ${s.ca.aia.join(' | ') || '—'}`,
    `CRL-Dateien: ${s.ca.crlDateien.map(c => `${c.datei} (${c.geschrieben})`).join(', ') || 'keine'}`,
  ].join('\n');
}

// ── v1812 Etappe 2a: Rolle, Offline-Root, Artefakte ───────────────────────────────────────────────────────────────────────────────

/** CA-Namen: Buchstaben, Ziffern, Leerzeichen, - . _ (kein Komma/Gleich, damit der DN eindeutig bleibt) */
export const CA_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,62}$/;

export interface RootParameter {
  ca_name: string; key_bits: number; hash: string; validity_years: number; path_length: number;
  crl_wochen: number; crl_ueberlappung_wochen: number; ausgestellt_jahre: number;
}

/** Eingabe für root_initialisieren prüfen und mit den Werten aus Architektur f583a405 ergänzen */
export function pruefeRoot(o: Record<string, unknown>): RootParameter | string {
  const n = (k: string, std: number) => (o[k] === undefined ? std : Number(o[k]));
  const r: RootParameter = {
    ca_name: String(o.ca_name ?? '').trim(), key_bits: n('key_bits', 4096), hash: String(o.hash ?? 'SHA256').toUpperCase(), validity_years: n('validity_years', 20),
    path_length: n('path_length', 1), crl_wochen: n('crl_wochen', 26), crl_ueberlappung_wochen: n('crl_ueberlappung_wochen', 4), ausgestellt_jahre: n('ausgestellt_jahre', 10),
  };
  if (!CA_NAME.test(r.ca_name)) return 'ca_name: 3–63 Zeichen, Buchstaben/Ziffern/Leerzeichen . _ -, z. B. „AD3033 Root CA“';
  if (![3072, 4096].includes(r.key_bits)) return 'key_bits: 3072 oder 4096';
  if (!['SHA256', 'SHA384', 'SHA512'].includes(r.hash)) return 'hash: SHA256, SHA384 oder SHA512';
  if (!Number.isInteger(r.validity_years) || r.validity_years < 5 || r.validity_years > 30) return 'validity_years: 5–30';
  if (!Number.isInteger(r.path_length) || r.path_length < 0 || r.path_length > 2) return 'path_length: 0–2 (Root mit einer Issuing-Ebene: 1)';
  if (!Number.isInteger(r.crl_wochen) || r.crl_wochen < 4 || r.crl_wochen > 52) return 'crl_wochen: 4–52';
  if (!Number.isInteger(r.crl_ueberlappung_wochen) || r.crl_ueberlappung_wochen < 1 || r.crl_ueberlappung_wochen >= r.crl_wochen) return 'crl_ueberlappung_wochen: 1 bis unter crl_wochen';
  if (!Number.isInteger(r.ausgestellt_jahre) || r.ausgestellt_jahre < 1 || r.ausgestellt_jahre >= r.validity_years) return 'ausgestellt_jahre: 1 bis unter validity_years (Issuing-CA endet vor der Root)';
  return r;
}

/** CAPolicy.inf der Root: Schlüssel/Laufzeit für Erneuerung, CRL-Periode, pathLen, keine alternative Signatur, KEIN CDP/AIA im Root-Zertifikat */
export function rootCapolicy(r: RootParameter): string {
  return [
    '[Version]', 'Signature="$Windows NT$"', '',
    '[Certsrv_Server]', `RenewalKeyLength=${r.key_bits}`, 'RenewalValidityPeriod=Years', `RenewalValidityPeriodUnits=${r.validity_years}`,
    'CRLPeriod=Weeks', `CRLPeriodUnits=${r.crl_wochen}`, 'CRLDeltaPeriod=Days', 'CRLDeltaPeriodUnits=0', 'AlternateSignatureAlgorithm=0', '',
    '[BasicConstraintsExtension]', `PathLength=${r.path_length}`, 'Critical=Yes', '',
  ].join('\r\n');
}

/** Rolle ADCS-Cert-Authority installieren (ohne Web Enrollment/NDES); wiederholbar; meldet vorher/nachher und Neustartbedarf */
export function featuresSkript(): string {
  return [
    ...kopf({}, false),
    "$vorher = [bool](Get-WindowsFeature -Name ADCS-Cert-Authority).Installed",
    "if ($vorher) { Ergebnis ([ordered]@{ zustand = 'schon'; vorher = $true; nachher = $true; neustart = $false }); exit 0 }",
    "$x = Install-WindowsFeature -Name ADCS-Cert-Authority -IncludeManagementTools",
    "if (-not $x.Success) { throw ('Install-WindowsFeature: ' + [string]$x.ExitCode) }",
    "$weitere = @(Get-WindowsFeature | Where-Object { $_.Installed -and $_.Name -in @('ADCS-Web-Enrollment', 'ADCS-Device-Enrollment', 'ADCS-Online-Cert', 'ADCS-Enroll-Web-Pol', 'ADCS-Enroll-Web-Svc') } | ForEach-Object { $_.Name })",
    "if ($weitere.Count) { throw ('unerwartete AD-CS-Nebenrollen: ' + ($weitere -join ', ')) }",
    "Ergebnis ([ordered]@{ zustand = 'installiert'; vorher = $false; nachher = [bool](Get-WindowsFeature -Name ADCS-Cert-Authority).Installed; neustart = [string]$x.RestartNeeded -eq 'Yes' })",
  ].join('\n');
}

/** Rückweg: Rolle nur entfernen, solange KEINE CA eingerichtet ist */
export function featuresEntfernenSkript(): string {
  return [
    ...kopf({}, false),
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "if ((Test-Path $k) -and [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active) { throw 'Es ist eine CA eingerichtet — Rolle wird nicht entfernt (Stilllegung ist ein eigener Change)' }",
    "if (-not (Get-WindowsFeature -Name ADCS-Cert-Authority).Installed) { Ergebnis ([ordered]@{ zustand = 'schon entfernt' }); exit 0 }",
    "$x = Uninstall-WindowsFeature -Name ADCS-Cert-Authority -IncludeManagementTools",
    "Ergebnis ([ordered]@{ zustand = 'entfernt'; neustart = [string]$x.RestartNeeded -eq 'Yes' })",
  ].join('\n');
}

/**
 * Offline-Root anlegen — NUR ohne Netzwerkkarte und außerhalb einer Domäne (Absicherung im Skript selbst). Wiederholbar: gibt es die CA
 * mit diesem Namen schon, „schon“; eine CA mit ANDEREM Namen bricht ab. Danach CRL-Fristen und Laufzeit ausgestellter Zertifikate setzen,
 * CDP/AIA-Vorgaben leeren (eigener Baustein publication_setzen), Dienst starten, erste CRL.
 */
export function rootInitSkript(r: RootParameter): string {
  return [
    ...kopf(r, false),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.PartOfDomain) { throw 'Offline-Root nur außerhalb einer Domäne (Workgroup)' }",
    "$nic = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter 'PhysicalAdapter=TRUE')",
    "if ($nic.Count) { throw ('Offline-Root nur OHNE Netzwerkkarte — gefunden: ' + (($nic | ForEach-Object { $_.Name }) -join ', ')) }",
    "if (-not (Get-WindowsFeature -Name ADCS-Cert-Authority).Installed) { throw 'Rolle ADCS-Cert-Authority fehlt (erst features_installieren)' }",
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })",
    "if ($aktiv -and $aktiv -ne $p.ca_name) { throw ('Es gibt bereits die CA „' + $aktiv + '“ — nichts verändert') }",
    '$schon = [bool]$aktiv',
    'if (-not $schon) {',
    `  [IO.File]::WriteAllText((Join-Path $env:SystemRoot 'CAPolicy.inf'), ${psText(rootCapolicy(r))}, [Text.Encoding]::ASCII)`,
    "  Install-AdcsCertificationAuthority -CAType StandaloneRootCA -CACommonName $p.ca_name -KeyLength ([int]$p.key_bits) -HashAlgorithmName $p.hash -CryptoProviderName 'RSA#Microsoft Software Key Storage Provider' -ValidityPeriod Years -ValidityPeriodUnits ([int]$p.validity_years) -Force | Out-Null",
    '}',
    "& certutil.exe -setreg CA\\CRLPeriod Weeks | Out-Null; & certutil.exe -setreg CA\\CRLPeriodUnits ([int]$p.crl_wochen) | Out-Null",
    "& certutil.exe -setreg CA\\CRLOverlapPeriod Weeks | Out-Null; & certutil.exe -setreg CA\\CRLOverlapUnits ([int]$p.crl_ueberlappung_wochen) | Out-Null",
    "& certutil.exe -setreg CA\\CRLDeltaPeriodUnits 0 | Out-Null",
    "& certutil.exe -setreg CA\\ValidityPeriod Years | Out-Null; & certutil.exe -setreg CA\\ValidityPeriodUnits ([int]$p.ausgestellt_jahre) | Out-Null",
    "& certutil.exe -setreg CA\\AuditFilter 127 | Out-Null",
    "Restart-Service -Name CertSvc -Force",
    "$bis = (Get-Date).AddMinutes(2); do { Start-Sleep -Seconds 3 } while ((Get-Service CertSvc).Status -ne 'Running' -and (Get-Date) -lt $bis)",
    "& certutil.exe -crl | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw ('certutil -crl Exit ' + $LASTEXITCODE) }",
    "Ergebnis ([ordered]@{ zustand = $(if ($schon) { 'schon' } else { 'angelegt' }); ca = $p.ca_name; dienst = [string](Get-Service CertSvc).Status })",
  ].join('\n');
}

/**
 * Artefakte einer CA lesen (lesend): aktuelles CA-Zertifikat (DER, Base64, SHA-256, Thumbprint) und neueste Basis-CRL
 * (Base64, SHA-256, CRL-Nummer, ThisUpdate/NextUpdate aus certutil -dump). Für die hashgeprüfte Übertragung zu fs01/AD/Issuer.
 */
export function artefakteSkript(): string {
  return [
    ...kopf({}, false),
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })",
    "if (-not $aktiv) { throw 'keine CA eingerichtet' }",
    "$h = @((Get-ItemProperty (Join-Path $k $aktiv)).CACertHash | ForEach-Object { ([string]$_) -replace '\\s', '' }) | Select-Object -Last 1",
    "$z = Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Thumbprint -eq $h } | Select-Object -First 1",
    "if (-not $z) { throw 'CA-Zertifikat nicht im Speicher LocalMachine\\My' }",
    '$sha = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    '$der = $z.RawData',
    "$r = [ordered]@{ ca = $aktiv; zertifikat = [ordered]@{ subject = $z.Subject; thumbprint = $z.Thumbprint; sha256 = (Hex $der); base64 = [Convert]::ToBase64String($der); bis = $z.NotAfter.ToString('s') } }",
    "$crl = Get-ChildItem (Join-Path $env:SystemRoot 'System32\\CertSrv\\CertEnroll') -Filter *.crl -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\\+\\.crl$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
    'if ($crl) {',
    '  $b = [IO.File]::ReadAllBytes($crl.FullName)',
    "  $d = (& certutil.exe -dump $crl.FullName) -join \"`n\"",
    "  $nr = $(if ($d -match 'CRL Number[^\\n]*\\n\\s*(?:CRL Number=)?([0-9a-fA-F]+)') { $Matches[1] } else { '' })",
    "  $diese = $(if ($d -match 'ThisUpdate:\\s*([^\\n]+)') { $Matches[1].Trim() } else { '' }); $naechste = $(if ($d -match 'NextUpdate:\\s*([^\\n]+)') { $Matches[1].Trim() } else { '' })",
    "  $r.crl = [ordered]@{ datei = $crl.Name; sha256 = (Hex $b); base64 = [Convert]::ToBase64String($b); nummer = $nr; thisUpdate = $diese; nextUpdate = $naechste; geschrieben = $crl.LastWriteTime.ToString('s') }",
    '}',
    'Ergebnis $r',
  ].join('\n');
}

export interface PkiArtefakte {
  ca: string;
  zertifikat: { subject: string; thumbprint: string; sha256: string; base64: string; bis: string };
  crl?: { datei: string; sha256: string; base64: string; nummer: string; thisUpdate: string; nextUpdate: string; geschrieben: string };
}

// ── v1812 Etappe 2b: Veröffentlichungspunkte, Issuing-Anforderung, Offline-Signatur, Aktivierung ─────────────────────────────────

/** Dateiname der Artefakte im Web (pki.ad.3033.at/pki/<name>.crl|.crt) — ohne Leerzeichen, damit URLs nicht kodiert werden müssen */
export const DATEI_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const HTTP_BASIS = /^http:\/\/[a-z0-9]([a-z0-9.-]{0,200}[a-z0-9])?\/([a-z0-9._-]+\/)*$/;
const UNC_BASIS = /^\\\\[A-Za-z0-9.-]{1,200}\\[A-Za-z0-9$._-]{1,80}(\\[A-Za-z0-9._-]{1,80})*\\$/;
/** Rohe Einträge (nur für den Rückweg mit dem gemeldeten „vorher“): <Flags>:<Ort>, Orte lokal/http/file/ldap — keine Steuerzeichen */
const ROH = /^\d{1,3}:[^\r\n"`]{1,400}$/;

export interface Publikation { cdp: string[]; aia: string[]; crl?: { periode: string; anzahl: number; ueberlappungPeriode: string; ueberlappungAnzahl: number } }

/**
 * CDP/AIA aus strukturierten Angaben: lokal (Flag 1, CertEnroll) + HTTP in die Erweiterungen (Flag 2) + optional Veröffentlichung auf
 * eine UNC-Freigabe (Flag 1, z. B. \\fs01\pki$\). Kein LDAP (Owner-Architektur: nur HTTP). Alternativ cdp_roh/aia_roh = gemeldetes „vorher“.
 */
export function pruefePublikation(o: Record<string, unknown>): Publikation | string {
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split('\n') : []).map(x => x.trim()).filter(Boolean);
  const roh = liste(o.cdp_roh).length || liste(o.aia_roh).length;
  let cdp: string[]; let aia: string[];
  if (roh) {
    cdp = liste(o.cdp_roh); aia = liste(o.aia_roh);
    if (!cdp.length || !aia.length || [...cdp, ...aia].some(x => !ROH.test(x))) return 'cdp_roh/aia_roh: beide Listen im Format <Flags>:<Ort> (wie in „vorher“ gemeldet)';
  } else {
    const name = String(o.datei_name ?? '').trim(); const http = String(o.http_basis ?? '').trim(); const unc = o.unc_ziel === undefined ? '' : String(o.unc_ziel).trim();
    if (!DATEI_NAME.test(name)) return 'datei_name: Kleinbuchstaben/Ziffern/-, z. B. ad3033-root';
    if (!HTTP_BASIS.test(http)) return 'http_basis: http://<host>/<pfad>/ mit abschließendem /, z. B. http://pki.ad.3033.at/pki/';
    if (unc && !UNC_BASIS.test(unc)) return 'unc_ziel: \\\\server\\freigabe\\ mit abschließendem \\';
    const lokal = '%windir%\\system32\\CertSrv\\CertEnroll\\';
    cdp = [`1:${lokal}${name}%8%9.crl`, `2:${http}${name}%8%9.crl`, ...(unc ? [`1:file://${unc}${name}%8%9.crl`] : [])];
    aia = [`1:${lokal}${name}%4.crt`, `2:${http}${name}%4.crt`, ...(unc ? [`1:file://${unc}${name}%4.crt`] : [])];
  }
  const r: Publikation = { cdp, aia };
  if (o.crl_anzahl !== undefined) {
    const e = String(o.crl_einheit ?? 'Days'); const ue = String(o.ueberlappung_einheit ?? e);
    const n = Number(o.crl_anzahl); const un = Number(o.ueberlappung_anzahl ?? 0);
    if (!['Hours', 'Days', 'Weeks'].includes(e) || !['Hours', 'Days', 'Weeks'].includes(ue)) return 'crl_einheit/ueberlappung_einheit: Hours, Days oder Weeks';
    if (!Number.isInteger(n) || n < 1 || n > 104 || !Number.isInteger(un) || un < 0 || un > 104) return 'crl_anzahl 1–104, ueberlappung_anzahl 0–104';
    r.crl = { periode: e, anzahl: n, ueberlappungPeriode: ue, ueberlappungAnzahl: un };
  }
  return r;
}

/** CDP/AIA (und optional CRL-Periode) setzen, Dienst neu starten, neue CRL; Ergebnis mit vorher/nachher für den Rückweg */
export function publikationSkript(pb: Publikation): string {
  return [
    ...kopf(pb, false),
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })",
    "if (-not $aktiv) { throw 'keine CA eingerichtet' }",
    '$c = Get-ItemProperty (Join-Path $k $aktiv)',
    '$vorher = [ordered]@{ cdp = @($c.CRLPublicationURLs | ForEach-Object { [string]$_ }); aia = @($c.CACertPublicationURLs | ForEach-Object { [string]$_ }) }',
    "Set-ItemProperty -Path (Join-Path $k $aktiv) -Name CRLPublicationURLs -Value ([string[]]@($p.cdp)) -Type MultiString",
    "Set-ItemProperty -Path (Join-Path $k $aktiv) -Name CACertPublicationURLs -Value ([string[]]@($p.aia)) -Type MultiString",
    'if ($p.crl) {',
    "  & certutil.exe -setreg CA\\CRLPeriod $p.crl.periode | Out-Null; & certutil.exe -setreg CA\\CRLPeriodUnits ([int]$p.crl.anzahl) | Out-Null",
    "  & certutil.exe -setreg CA\\CRLOverlapPeriod $p.crl.ueberlappungPeriode | Out-Null; & certutil.exe -setreg CA\\CRLOverlapUnits ([int]$p.crl.ueberlappungAnzahl) | Out-Null",
    "  & certutil.exe -setreg CA\\CRLDeltaPeriodUnits 0 | Out-Null",
    '}',
    "Restart-Service -Name CertSvc -Force",
    "$bis = (Get-Date).AddMinutes(2); do { Start-Sleep -Seconds 3 } while ((Get-Service CertSvc).Status -ne 'Running' -and (Get-Date) -lt $bis)",
    "& certutil.exe -crl | Out-Null",
    "$crlExit = $LASTEXITCODE",
    '$n = Get-ItemProperty (Join-Path $k $aktiv)',
    "Ergebnis ([ordered]@{ ca = $aktiv; vorher = $vorher; nachher = [ordered]@{ cdp = @($n.CRLPublicationURLs | ForEach-Object { [string]$_ }); aia = @($n.CACertPublicationURLs | ForEach-Object { [string]$_ }) }; dienst = [string](Get-Service CertSvc).Status; crlExit = $crlExit })",
  ].join('\n');
}

/** Neue Basis-CRL ausstellen (CRL-Nummern steigen nur; kein Zurücksetzen) */
export function crlSkript(): string {
  return [
    ...kopf({}, false),
    "if ((Get-Service CertSvc -ErrorAction SilentlyContinue).Status -ne 'Running') { throw 'CertSvc läuft nicht' }",
    "& certutil.exe -crl | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw ('certutil -crl Exit ' + $LASTEXITCODE) }",
    "Ergebnis ([ordered]@{ zustand = 'CRL ausgestellt'; zeit = (Get-Date).ToString('s') })",
  ].join('\n');
}

export interface IssuerParameter { ca_name: string; key_bits: number; hash: string; path_length: number; ausKonto?: string }
export function pruefeIssuer(o: Record<string, unknown>): IssuerParameter | string {
  const r: IssuerParameter = { ca_name: String(o.ca_name ?? '').trim(), key_bits: o.key_bits === undefined ? 4096 : Number(o.key_bits), hash: String(o.hash ?? 'SHA256').toUpperCase(), path_length: o.path_length === undefined ? 0 : Number(o.path_length) };
  if (!CA_NAME.test(r.ca_name)) return 'ca_name: 3–63 Zeichen, z. B. „AD3033 Issuing CA 1“';
  if (![3072, 4096].includes(r.key_bits)) return 'key_bits: 3072 oder 4096';
  if (!['SHA256', 'SHA384', 'SHA512'].includes(r.hash)) return 'hash: SHA256, SHA384 oder SHA512';
  if (r.path_length !== 0) return 'path_length: 0 (Issuing-CA stellt keine weiteren CAs aus)';
  return r;
}

/** CAPolicy.inf der Issuing-CA: pathLen 0 kritisch, keine Standardvorlagen (nur gezielt veröffentlichte), keine alternative Signatur */
export function issuerCapolicy(r: IssuerParameter): string {
  return [
    '[Version]', 'Signature="$Windows NT$"', '',
    '[Certsrv_Server]', `RenewalKeyLength=${r.key_bits}`, 'LoadDefaultTemplates=0', 'AlternateSignatureAlgorithm=0', 'CRLDeltaPeriodUnits=0', '',
    '[BasicConstraintsExtension]', `PathLength=${r.path_length}`, 'Critical=Yes', '',
  ].join('\r\n');
}

/**
 * Enterprise-Subordinate anlegen bis zur Anforderung (Schlüssel bleibt auf der Issuing-CA). AD-Teil mit -Credential des
 * Domänen-Administrators (Enterprise Admins; Kennwort über stdin). Wiederholbar: steht die CA schon auf dieser Anforderung,
 * kommt DIESELBE Anforderung zurück (kein neuer Schlüssel).
 */
export function issuerAnfordernSkript(r: IssuerParameter): string {
  return [
    ...kopf(r, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if (-not $cs.PartOfDomain) { throw 'Issuing-CA muss Domänenmitglied sein' }",
    "if (-not (Get-WindowsFeature -Name ADCS-Cert-Authority).Installed) { throw 'Rolle ADCS-Cert-Authority fehlt (erst features_installieren)' }",
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$req = Join-Path $dir ('issuer-' + ($p.ca_name -replace '[^A-Za-z0-9]', '_') + '.req')",
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = $(if (Test-Path $k) { [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active } else { '' })",
    "if ($aktiv -and $aktiv -ne $p.ca_name) { throw ('Es gibt bereits die CA „' + $aktiv + '“ — nichts verändert') }",
    "$zustand = 'schon'",
    'if (-not $aktiv) {',
    "  $nb = (Get-CimInstance -ClassName Win32_NTDomain | Where-Object { $_.DnsForestName } | Select-Object -First 1).DomainName",
    `  $cred = New-Object System.Management.Automation.PSCredential ((${kontoAusdruck('Administrator', '$nb')}), (ConvertTo-SecureString $e.kennwort -AsPlainText -Force))`,
    `  [IO.File]::WriteAllText((Join-Path $env:SystemRoot 'CAPolicy.inf'), ${psText(issuerCapolicy(r))}, [Text.Encoding]::ASCII)`,
    "  Install-AdcsCertificationAuthority -CAType EnterpriseSubordinateCA -CACommonName $p.ca_name -KeyLength ([int]$p.key_bits) -HashAlgorithmName $p.hash -CryptoProviderName 'RSA#Microsoft Software Key Storage Provider' -OutputCertRequestFile $req -Credential $cred -Force | Out-Null",
    "  $zustand = 'angefordert'",
    '}',
    "if (-not (Test-Path $req)) { throw ('Anforderungsdatei fehlt: ' + $req + ' — CA steht nicht auf Anforderung') }",
    "$txt = [IO.File]::ReadAllText($req); $b64 = ($txt -replace '-----[^-]+-----', '' -replace '\\s', '')",
    "$der = [Convert]::FromBase64String($b64)",
    "$sha = (([Security.Cryptography.SHA256]::Create().ComputeHash($der)) | ForEach-Object { $_.ToString('x2') }) -join ''",
    "Ergebnis ([ordered]@{ zustand = $zustand; ca = $p.ca_name; csrBase64 = $b64; csrSha256 = $sha; datei = $req; domaene = [string]$cs.Domain })",
  ].join('\n');
}

const HEX64 = /^[0-9a-f]{64}$/;
export interface SignierParameter { erwartet_csr_sha256: string; erwartet_subject: string; path_length: number }
export function pruefeSignieren(o: Record<string, unknown>): SignierParameter | string {
  const r = { erwartet_csr_sha256: String(o.erwartet_csr_sha256 ?? '').trim().toLowerCase(), erwartet_subject: String(o.erwartet_subject ?? '').trim(), path_length: o.path_length === undefined ? 0 : Number(o.path_length) };
  if (!HEX64.test(r.erwartet_csr_sha256)) return 'erwartet_csr_sha256: SHA-256 der Anforderung aus issuer_anfordern (64 Hex-Zeichen)';
  if (!CA_NAME.test(r.erwartet_subject)) return 'erwartet_subject: CA-Name der Issuing-CA (CN)';
  if (r.path_length !== 0) return 'path_length: 0';
  if (typeof o.csr_base64 !== 'string' || !/^[A-Za-z0-9+/=]{100,20000}$/.test(o.csr_base64)) return 'csr_base64: Anforderung (Base64) aus issuer_anfordern';
  return r;
}

/**
 * Auf der Offline-Root (Gastagent): Anforderung aus stdin, Hash gegen erwartet prüfen, einreichen, ausstellen (resubmit), abholen.
 * Wiederholbar über den Hash: eine schon signierte Anforderung liefert dasselbe Zertifikat (keine zweite Ausstellung).
 * Prüft das Ergebnis: Subject, pathLen, Aussteller = diese Root. Dazu Root-Zertifikat und aktuelle Root-CRL für die Übergabe.
 */
export function signierenSkript(r: SignierParameter): string {
  return [
    ...kopf(r, true),
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = [string](Get-ItemProperty $k -ErrorAction Stop).Active",
    "$c = Get-ItemProperty (Join-Path $k $aktiv)",
    "if ([int]$c.CAType -ne 3) { throw 'nur auf einer Standalone-Root signieren' }",
    "if (@(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter 'PhysicalAdapter=TRUE').Count) { throw 'Root hat eine Netzwerkkarte — nichts signiert' }",
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($shaF.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    '$der = [Convert]::FromBase64String([string]$e.csr_base64)',
    "if ((Hex $der) -ne $p.erwartet_csr_sha256) { throw ('Anforderung passt nicht zum erwarteten Hash (' + (Hex $der) + ')') }",
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$ziel = Join-Path $dir ('signiert-' + $p.erwartet_csr_sha256 + '.cer')",
    "$zustand = 'schon signiert'",
    'if (-not (Test-Path $ziel)) {',
    "  $req = Join-Path $dir ('anf-' + $p.erwartet_csr_sha256 + '.req')",
    "  [IO.File]::WriteAllText($req, \"-----BEGIN NEW CERTIFICATE REQUEST-----`r`n\" + [Convert]::ToBase64String($der, 'InsertLineBreaks') + \"`r`n-----END NEW CERTIFICATE REQUEST-----`r`n\")",
    "  $cfg = $env:COMPUTERNAME + '\\' + $aktiv",
    "  $aus = (& certreq.exe -q -config $cfg -submit $req) -join \"`n\"",
    "  if ($aus -notmatch 'RequestId:\\s*\"?(\\d+)') { throw ('certreq -submit: ' + $aus) }",
    '  $id = $Matches[1]',
    "  & certutil.exe -config $cfg -resubmit $id | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw ('certutil -resubmit ' + $id + ' Exit ' + $LASTEXITCODE) }",
    "  $tmp = Join-Path $dir ('abgeholt-' + $id + '.cer'); if (Test-Path $tmp) { Remove-Item $tmp -Force }",
    "  & certreq.exe -q -config $cfg -retrieve $id $tmp | Out-Null",
    "  if (-not (Test-Path $tmp)) { throw ('certreq -retrieve ' + $id + ' lieferte kein Zertifikat') }",
    "  Move-Item $tmp $ziel; $zustand = 'signiert (Anforderung ' + $id + ')'",
    '}',
    '$z = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $ziel',
    "$root = Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Thumbprint -eq ((@($c.CACertHash) | Select-Object -Last 1) -replace '\\s', '') } | Select-Object -First 1",
    "if ($z.Issuer -ne $root.Subject) { throw ('Aussteller ' + $z.Issuer + ' ist nicht diese Root') }",
    "if ($z.Subject -notmatch ('CN=' + [regex]::Escape($p.erwartet_subject) + '(,|$)')) { throw ('Subject ' + $z.Subject + ' passt nicht zu ' + $p.erwartet_subject) }",
    "$bc = $z.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1",
    "$pl = $(if ($bc) { $b = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]$bc; if (-not $b.CertificateAuthority) { 'kein CA-Zertifikat' } elseif ($b.HasPathLengthConstraint) { [string]$b.PathLengthConstraint } else { 'ohne' } } else { 'keine' })",
    "if ($pl -ne [string]$p.path_length) { throw ('pathLen ist ' + $pl + ', verlangt ' + $p.path_length + ' — Zertifikat NICHT übergeben') }",
    "$cdp = $(($z.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.31' } | Select-Object -First 1).Format($false))",
    "$aia = $(($z.Extensions | Where-Object { $_.Oid.Value -eq '1.3.6.1.5.5.7.1.1' } | Select-Object -First 1).Format($false))",
    "$crl = Get-ChildItem (Join-Path $env:SystemRoot 'System32\\CertSrv\\CertEnroll') -Filter *.crl | Where-Object { $_.Name -notmatch '\\+\\.crl$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
    "$cb = $(if ($crl) { [IO.File]::ReadAllBytes($crl.FullName) } else { $null })",
    "Ergebnis ([ordered]@{ zustand = $zustand; zertifikat = [ordered]@{ base64 = [Convert]::ToBase64String($z.RawData); sha256 = (Hex $z.RawData); thumbprint = $z.Thumbprint; seriennummer = $z.SerialNumber; subject = $z.Subject; aussteller = $z.Issuer; von = $z.NotBefore.ToString('s'); bis = $z.NotAfter.ToString('s'); pathLen = $pl; cdp = [string]$cdp; aia = [string]$aia }; root = [ordered]@{ base64 = [Convert]::ToBase64String($root.RawData); sha256 = (Hex $root.RawData); thumbprint = $root.Thumbprint }; rootCrl = $(if ($cb) { [ordered]@{ base64 = [Convert]::ToBase64String($cb); sha256 = (Hex $cb); datei = $crl.Name } } else { $null }) })",
  ].join('\n');
}

export interface Signiert {
  zustand: string;
  zertifikat: { base64: string; sha256: string; thumbprint: string; seriennummer: string; subject: string; aussteller: string; von: string; bis: string; pathLen: string; cdp: string; aia: string };
  root: { base64: string; sha256: string; thumbprint: string };
  rootCrl: { base64: string; sha256: string; datei: string } | null;
}

export interface AktivierParameter { erwartet_zert_sha256: string; erwartet_root_sha256: string; erwartet_crl_sha256: string }
export function pruefeAktivieren(o: Record<string, unknown>): AktivierParameter | string {
  const r = { erwartet_zert_sha256: String(o.erwartet_zert_sha256 ?? '').toLowerCase(), erwartet_root_sha256: String(o.erwartet_root_sha256 ?? '').toLowerCase(), erwartet_crl_sha256: String(o.erwartet_crl_sha256 ?? '').toLowerCase() };
  if (![r.erwartet_zert_sha256, r.erwartet_root_sha256, r.erwartet_crl_sha256].every(x => HEX64.test(x))) return 'erwartet_zert_sha256, erwartet_root_sha256, erwartet_crl_sha256: SHA-256 aus subordinate_signieren';
  for (const f of ['zert_base64', 'root_base64', 'crl_base64']) if (typeof o[f] !== 'string' || !/^[A-Za-z0-9+/=]{100,200000}$/.test(String(o[f]))) return `${f}: Base64 aus subordinate_signieren`;
  return r;
}

/**
 * Auf der Issuing-CA: Root-Zertifikat und Root-CRL hashgeprüft in LocalMachine\Root, signiertes Zertifikat hashgeprüft installieren
 * (certutil -installcert), Dienst starten. Wiederholbar: ist das Zertifikat schon das CA-Zertifikat, nur prüfen.
 */
export function aktivierenSkript(r: AktivierParameter): string {
  return [
    ...kopf(r, true),
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($shaF.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    '$zb = [Convert]::FromBase64String([string]$e.zert_base64); $rb = [Convert]::FromBase64String([string]$e.root_base64); $cb = [Convert]::FromBase64String([string]$e.crl_base64)',
    "if ((Hex $zb) -ne $p.erwartet_zert_sha256) { throw 'Zertifikat passt nicht zum erwarteten Hash' }",
    "if ((Hex $rb) -ne $p.erwartet_root_sha256) { throw 'Root-Zertifikat passt nicht zum erwarteten Hash' }",
    "if ((Hex $cb) -ne $p.erwartet_crl_sha256) { throw 'Root-CRL passt nicht zum erwarteten Hash' }",
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$zd = Join-Path $dir 'issuer.cer'; $rd = Join-Path $dir 'root.cer'; $cd = Join-Path $dir 'root.crl'",
    '[IO.File]::WriteAllBytes($zd, $zb); [IO.File]::WriteAllBytes($rd, $rb); [IO.File]::WriteAllBytes($cd, $cb)',
    "& certutil.exe -f -addstore Root $rd | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('Root-Zertifikat in LocalMachine\\Root: Exit ' + $LASTEXITCODE) }",
    "& certutil.exe -f -addstore Root $cd | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('Root-CRL in LocalMachine\\Root: Exit ' + $LASTEXITCODE) }",
    '$z = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $zd',
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$aktiv = [string](Get-ItemProperty $k -ErrorAction Stop).Active",
    "if (-not $aktiv) { throw 'keine CA eingerichtet (erst issuer_anfordern)' }",
    "$hatSchon = @((Get-ItemProperty (Join-Path $k $aktiv)).CACertHash | ForEach-Object { ([string]$_) -replace '\\s', '' }) -contains $z.Thumbprint",
    "$zustand = 'schon aktiv'",
    'if (-not $hatSchon) {',
    "  $aus = (& certutil.exe -installcert $zd) -join ' '",
    "  if ($LASTEXITCODE -ne 0) { throw ('certutil -installcert Exit ' + $LASTEXITCODE + ': ' + $aus) }",
    "  $zustand = 'aktiviert'",
    '}',
    "Start-Service -Name CertSvc -ErrorAction SilentlyContinue",
    "$bis = (Get-Date).AddMinutes(2); do { Start-Sleep -Seconds 3 } while ((Get-Service CertSvc).Status -ne 'Running' -and (Get-Date) -lt $bis)",
    "if ((Get-Service CertSvc).Status -ne 'Running') { throw 'CertSvc startet nicht' }",
    "Ergebnis ([ordered]@{ zustand = $zustand; ca = $aktiv; thumbprint = $z.Thumbprint; dienst = 'Running' })",
  ].join('\n');
}

// ── v1813 Etappe 2c: HTTP-Veröffentlichung auf fs01, Übertragung, Prüfung, AD und Vertrauen ───────────────────────────────────────

const HOST = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/;
const ORDNER = /^[A-Za-z]:\\[A-Za-z0-9 ._-]{1,80}(\\[A-Za-z0-9 ._-]{1,80}){0,3}$/;
export interface PkiWeb { host: string; pfad: string; site: string }
export function pruefeWeb(o: Record<string, unknown>): PkiWeb | string {
  const r = { host: String(o.host_header ?? '').trim().toLowerCase(), pfad: String(o.pfad ?? '').trim(), site: String(o.site ?? 'Alfred-PKI').trim() };
  if (!HOST.test(r.host)) return 'host_header: FQDN, z. B. pki.ad.3033.at';
  if (!ORDNER.test(r.pfad)) return 'pfad: lokaler Ordner, z. B. W:\\PKI (vorher mit windows_cluster freigabe_anlegen als pki$ anlegen, aendern = Issuing-CA-Computerkonto)';
  if (!/^[A-Za-z][A-Za-z0-9-]{2,40}$/.test(r.site)) return 'site: Name der IIS-Site';
  return r;
}

/**
 * Statischer Webdienst für CRT/CRL: IIS nur mit statischem Inhalt und Anforderungsfilter, eigene Site mit Host-Header auf Port 80,
 * kein Verzeichnislisting, doppelte Escape-Sequenzen erlaubt (Delta-CRL-„+“), MIME .crl/.crt, anonymes Leserecht (IUSR) zusätzlich
 * zur vorhandenen Ordner-ACL. Andere Sites/Freigaben (Witness$, SQLBackup$) bleiben unberührt. Wiederholbar.
 */
export function webSkript(w: PkiWeb): string {
  return [
    ...kopf(w, false),
    "if (-not (Test-Path $p.pfad)) { throw ('Ordner ' + $p.pfad + ' fehlt (erst windows_cluster freigabe_anlegen)') }",
    "$f = Install-WindowsFeature -Name Web-WebServer, Web-Static-Content, Web-Filtering",
    "if (-not $f.Success) { throw ('Install-WindowsFeature Web: ' + [string]$f.ExitCode) }",
    "$ac = Join-Path $env:windir 'System32\\inetsrv\\appcmd.exe'",
    "$da = (& $ac list site /name:$($p.site)) -join ''",
    "$zustand = $(if ($da) { 'schon' } else { 'neu' })",
    "if (-not $da) { & $ac add site /name:$($p.site) /bindings:(\"http/*:80:\" + $p.host) /physicalPath:$($p.pfad) | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('appcmd add site Exit ' + $LASTEXITCODE) } }",
    "& $ac set config $p.site /section:system.webServer/directoryBrowse /enabled:false | Out-Null",
    "& $ac set config $p.site /section:system.webServer/security/requestFiltering /allowDoubleEscaping:true | Out-Null",
    "foreach ($m in @(@('.crl', 'application/pkix-crl'), @('.crt', 'application/pkix-cert'))) { if (-not ((& $ac list config $p.site /section:staticContent) -match [regex]::Escape($m[0]))) { & $ac set config $p.site /section:staticContent /+\"[fileExtension='$($m[0])',mimeType='$($m[1])']\" | Out-Null } }",
    '$acl = Get-Acl $p.pfad',
    "$iusr = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-17'",
    "if (-not ($acl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-17' })) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($iusr, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); Set-Acl -Path $p.pfad -AclObject $acl }",
    "& $ac start site /site.name:$($p.site) | Out-Null",
    "$st = (& $ac list site /name:$($p.site)) -join ''",
    "Ergebnis ([ordered]@{ zustand = $zustand; site = $st; pfad = $p.pfad; host = $p.host; listing = $(try { [string](Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1/' -Headers @{ Host = $p.host } -ErrorAction Stop).StatusCode } catch { [string]$_.Exception.Response.StatusCode.value__ }) })",
  ].join('\n');
}

/** Rückweg: nur die eigene Site entfernen (Features, Ordner, Dateien und Freigabe bleiben) */
export function webEntfernenSkript(w: { site: string }): string {
  return [
    ...kopf(w, false),
    "$ac = Join-Path $env:windir 'System32\\inetsrv\\appcmd.exe'",
    "if (-not (Test-Path $ac) -or -not ((& $ac list site /name:$($p.site)) -join '')) { Ergebnis ([ordered]@{ zustand = 'schon entfernt' }); exit 0 }",
    "& $ac delete site /site.name:$($p.site) | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw ('appcmd delete site Exit ' + $LASTEXITCODE) }",
    "Ergebnis ([ordered]@{ zustand = 'entfernt'; site = $p.site })",
  ].join('\n');
}

const ARTEFAKT_DATEI = /^[a-z0-9][a-z0-9-]{1,40}(\(\d{1,2}\))?\.(crl|crt)$/;
export function pruefeAblage(o: Record<string, unknown>): { ordner: string; datei: string; erwartet_sha256: string } | string {
  const r = { ordner: String(o.ordner ?? '').trim(), datei: String(o.datei ?? '').trim(), erwartet_sha256: String(o.erwartet_sha256 ?? '').trim().toLowerCase() };
  if (!ORDNER.test(r.ordner)) return 'ordner: lokaler Ordner der Veröffentlichung, z. B. W:\\PKI';
  if (!ARTEFAKT_DATEI.test(r.datei)) return 'datei: <name>.crl oder <name>.crt passend zu datei_name aus publication_setzen (z. B. ad3033-root.crl)';
  if (!/^[0-9a-f]{64}$/.test(r.erwartet_sha256)) return 'erwartet_sha256: SHA-256 aus artefakte_lesen/subordinate_signieren';
  if (typeof o.base64 !== 'string' || !/^[A-Za-z0-9+/=]{100,2000000}$/.test(o.base64)) return 'base64: Inhalt aus artefakte_lesen/subordinate_signieren';
  return r;
}
/** Datei hashgeprüft ablegen; CRLs nie durch eine ältere CRL-Nummer ersetzen; meldet den vorherigen Hash */
export function ablageSkript(a: { ordner: string; datei: string; erwartet_sha256: string }): string {
  return [
    ...kopf(a, true),
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($shaF.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    "function CrlNr($pfad) { $d = (& certutil.exe -dump $pfad) -join \"`n\"; if ($d -match 'CRL Number[^\\n]*\\n\\s*(?:CRL Number=)?([0-9a-fA-F]+)') { [Convert]::ToInt64($Matches[1], 16) } else { -1 } }",
    '$b = [Convert]::FromBase64String([string]$e.base64)',
    "if ((Hex $b) -ne $p.erwartet_sha256) { throw ('Inhalt passt nicht zum erwarteten Hash (' + (Hex $b) + ')') }",
    "if (-not (Test-Path $p.ordner)) { throw ('Ordner fehlt: ' + $p.ordner) }",
    '$ziel = Join-Path $p.ordner $p.datei',
    "$vorher = $(if (Test-Path $ziel) { Hex ([IO.File]::ReadAllBytes($ziel)) } else { '' })",
    "if ($vorher -eq $p.erwartet_sha256) { Ergebnis ([ordered]@{ zustand = 'schon aktuell'; datei = $ziel; sha256 = $vorher; vorher = $vorher }); exit 0 }",
    "$tmp = $ziel + '.alfred-neu'; [IO.File]::WriteAllBytes($tmp, $b)",
    "if ($p.datei -like '*.crl' -and $vorher) { $alt = CrlNr $ziel; $neu = CrlNr $tmp; if ($neu -lt $alt) { Remove-Item $tmp -Force; throw ('CRL-Nummer ' + $neu + ' ist älter als die veröffentlichte ' + $alt + ' — nicht ersetzt') } }",
    'Move-Item -Path $tmp -Destination $ziel -Force',
    "$nach = Hex ([IO.File]::ReadAllBytes($ziel)); if ($nach -ne $p.erwartet_sha256) { throw 'nach dem Schreiben anderer Hash' }",
    "Ergebnis ([ordered]@{ zustand = 'abgelegt'; datei = $ziel; sha256 = $nach; vorher = $vorher })",
  ].join('\n');
}

/** Von einem Client aus per HTTP abrufen (lesend): Status, keine Umleitung, Hash, bei CRLs Nummer/NextUpdate und Signaturprüfung gegen den Aussteller */
export function abrufSkript(a: { urls: string[]; erwartet: Record<string, string> }): string {
  return [
    ...kopf(a, false),
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($shaF.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    '$l = @()',
    'foreach ($u in @($p.urls)) {',
    "  $x = [ordered]@{ url = $u }",
    '  try {',
    "    $r = Invoke-WebRequest -UseBasicParsing -Uri $u -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop",
    "    $x.status = [int]$r.StatusCode; $b = $r.Content; if ($b -is [string]) { $b = [Text.Encoding]::GetEncoding(28591).GetBytes($b) }",
    "    $x.sha256 = Hex $b; $x.bytes = $b.Length; $x.typ = [string]$r.Headers['Content-Type']",
    "    $w = $p.erwartet.$u; if ($w) { $x.passt = ($x.sha256 -eq $w) }",
    "    if ($u -like '*.crl') { $t = [IO.Path]::GetTempFileName(); [IO.File]::WriteAllBytes($t, $b); $d = (& certutil.exe -dump $t) -join \"`n\"; Remove-Item $t -Force",
    "      $x.nummer = $(if ($d -match 'CRL Number[^\\n]*\\n\\s*(?:CRL Number=)?([0-9a-fA-F]+)') { $Matches[1] } else { '' }); $x.nextUpdate = $(if ($d -match 'NextUpdate:\\s*([^\\n]+)') { $Matches[1].Trim() } else { '' }) }",
    "  } catch { $x.status = $(try { [int]$_.Exception.Response.StatusCode } catch { 0 }); $x.fehler = $_.Exception.Message }",
    '  $l += $x',
    '}',
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s'); abrufe = $l })",
  ].join('\n');
}

/**
 * Root- (und optional Issuing-)Zertifikat im AD veröffentlichen (certutil -dspublish RootCA/SubCA) als Enterprise Admin per
 * Kennwort-Anmeldung; danach je DC lesend belegen, dass der Fingerprint im Container „Certification Authorities“ bzw. AIA steht.
 * NTAuth wird NICHT erweitert. Keine CRL ins AD (Architektur: nur HTTP).
 */
export function adVeroeffentlichenSkript(a: { dcs: string[]; erwartet_root_sha256: string; mit_sub: boolean; erwartet_sub_sha256?: string; ausKonto?: string }): string {
  const innen = innenSkript(a, [
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "function Hex($b) { ($shaF.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join '' }",
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'",
    "$rd = Join-Path $dir 'ad-root.cer'; $rb = [IO.File]::ReadAllBytes($rd); if ((Hex $rb) -ne $p.erwartet_root_sha256) { throw 'Root-Zertifikat passt nicht zum Hash' }",
    "$aus = (& certutil.exe -dspublish -f $rd RootCA) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('dspublish RootCA: ' + $aus) }",
    "$rt = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,$rb)).Thumbprint",
    "if ($p.mit_sub) { $sd = Join-Path $dir 'ad-sub.cer'; $sb = [IO.File]::ReadAllBytes($sd); if ((Hex $sb) -ne $p.erwartet_sub_sha256) { throw 'Issuing-Zertifikat passt nicht zum Hash' }; $aus = (& certutil.exe -dspublish -f $sd SubCA) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('dspublish SubCA: ' + $aus) }; $st = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,$sb)).Thumbprint }",
    "$cfg = ([adsi]'LDAP://RootDSE').configurationNamingContext",
    '$beleg = @()',
    'foreach ($dc in @($p.dcs)) {',
    "  function Fp($pfad) { $o = [adsi]('LDAP://' + $dc + '/' + $pfad); $f = @(); foreach ($ch in @($o.Children)) { foreach ($c in @($ch.cACertificate)) { $f += (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,[byte[]]$c)).Thumbprint } }; $f }",
    "  $root = @(Fp ('CN=Certification Authorities,CN=Public Key Services,CN=Services,' + $cfg))",
    "  $aia = @(Fp ('CN=AIA,CN=Public Key Services,CN=Services,' + $cfg))",
    "  $beleg += [ordered]@{ dc = $dc; rootDa = ($root -contains $rt); subDa = $(if ($p.mit_sub) { $aia -contains $st } else { $null }) }",
    '}',
    "[ordered]@{ rootThumbprint = $rt; subThumbprint = $(if ($p.mit_sub) { $st } else { $null }); belege = $beleg }",
  ]);
  return [
    ...kopf(a, true),
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "[IO.File]::WriteAllBytes((Join-Path $dir 'ad-root.cer'), [Convert]::FromBase64String([string]$e.root_base64))",
    "if ($p.mit_sub) { [IO.File]::WriteAllBytes((Join-Path $dir 'ad-sub.cer'), [Convert]::FromBase64String([string]$e.sub_base64)) }",
    MIT_KONTO,
    "$nb = DomaeneNetbios",
    `$w = MitKonto (${kontoAusdruck('Administrator', '$nb')}) $e.kennwort ${psText(innen)} 300`,
    'Ergebnis $w',
  ].join('\n');
}

/** Vertrauen nachladen (Gruppenrichtlinie, Autoenrollment-Puls) — wirkt nur additiv; danach trust_pruefen */
export function trustAktualisierenSkript(): string {
  return [
    ...kopf({}, false),
    "& gpupdate.exe /target:computer /force | Out-Null",
    "& certutil.exe -pulse | Out-Null",
    "Ergebnis ([ordered]@{ zustand = 'aktualisiert'; zeit = (Get-Date).ToString('s') })",
  ].join('\n');
}

/** Lesend: stehen die erwarteten Fingerprints im LocalMachine-Root- bzw. Zwischenspeicher dieses Rechners? */
export function trustPruefenSkript(a: { root: string[]; zwischen: string[] }): string {
  return [
    ...kopf(a, false),
    "$r = @(Get-ChildItem Cert:\\LocalMachine\\Root | ForEach-Object { $_.Thumbprint })",
    "$z = @(Get-ChildItem Cert:\\LocalMachine\\CA | ForEach-Object { $_.Thumbprint })",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; zeit = (Get-Date).ToString('s'); root = @(@($p.root) | ForEach-Object { [ordered]@{ thumbprint = $_; da = ($r -contains $_) } }); zwischen = @(@($p.zwischen) | ForEach-Object { [ordered]@{ thumbprint = $_; da = ($z -contains $_ -or $r -contains $_) } }) })",
  ].join('\n');
}

