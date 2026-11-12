/**
 * Vorhaben 3bb8c058 — eigene PKI (Offline-Root + Enterprise-Issuing-CA) über feste PowerShell-Bausteine.
 * Online-CAs (Domänenmitglied) über den Windows-Fernzugang (SSH), die netzlose Offline-Root über den QEMU-Gastagenten von Proxmox.
 * v1810: nur der lesende Status (Spec-Position 1); die ändernden Bausteine folgen in Etappe 2.
 */
import { kopf } from './windows-ad.js';

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
