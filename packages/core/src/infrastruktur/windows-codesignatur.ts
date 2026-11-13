/**
 * PKI Etappe 3a — Codesignatur der Windows-Bausteine (Owner-Entscheidung 13.11.: Schlüssel auf dem Alfred-Server, 1 Jahr,
 * nur signieren und prüfen).
 *
 *   - Vorlage <vorlage> auf der Issuing-CA: Kopie von „Code Signing“ (Schema 2), RSA ≥ 3072, nur Codesignatur, Name aus der
 *     Anforderung, JEDE Anforderung wartet auf Freigabe an der CA, Registrieren nur Domänen-Admins.
 *   - Schlüssel und Anforderung entstehen auf dem Alfred-Server (openssl); zur CA geht nur die Anforderung. Der Change stellt aus
 *     (resubmit als CA-Verwalter), Alfred prüft Schlüssel, Verwendung und Aussteller und legt Schlüssel + Kette ab — wie Alfreds
 *     SSH-Schlüssel als Datei im Datenordner (Ordner 700, Schlüssel 600), nicht im Tresor: der Tresor gibt Werte nur während
 *     freigegebener Changes heraus, signiert wird aber auch bei lesenden Bausteinen; der Schlüssel verlässt den Server nie.
 *   - Jedes Skript wird vor dem Hochladen signiert (osslsigncode, ohne Zeitstempel — die Skripte leben Sekunden) und vor dem
 *     Start von außen geprüft: HashMismatch/NotSigned (Datei nach dem Signieren verändert) bricht ab, alles andere wird gemeldet.
 */
import { X509Certificate, createPublicKey } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kopf, psText, kontoAusdruck } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';

export const EKU_CODESIGNATUR = '1.3.6.1.5.5.7.3.3';
export const ENROLL_RECHT = '0e10c968-78fb-11d2-90d4-00c04f79dc55';
/** Statuswerte, die nach dem Signieren nur durch Veränderung der Datei entstehen */
export const SIGNATUR_ABBRUCH = new Set(['HashMismatch', 'NotSigned']);
export const SIGNATUR_STATUS = new Set(['Valid', 'UnknownError', 'NotTrusted', 'HashMismatch', 'NotSigned', 'NotSupportedFileFormat', 'Incompatible']);

const VORLAGE = /^[A-Za-z][A-Za-z0-9-]{2,39}$/;

/**
 * v1852 — Vorlagenprofile: Codesignatur (3a) und SQL-TLS (3b, Spec 252217f3 Pos. 11). Die Werte gehen als JSON ins Skript ($p.profil),
 * nicht als Text in die Befehle.
 */
/** maschine: CT_FLAG_MACHINE_TYPE (0x40) — v1854, Realfall fad4b31b Schritt 4: ohne das Kennzeichen ist die Vorlage eine Benutzer-Vorlage,
 *  certreq -new im Computerkontext meldet „Machine context template conflicts“ */
export interface VorlagenProfil { eku: string; ku: [number, number]; keySpec: 1 | 2; csp: string; ueberlappungTage: number; adminsRegistrieren: boolean; maschine?: boolean; gruppe?: { name: string; ou: string; mitglieder: string[] } }
export const PROFIL_CODESIGNATUR: VorlagenProfil = { eku: EKU_CODESIGNATUR, ku: [0x80, 0x00], keySpec: 2, csp: '1,Microsoft Enhanced RSA and AES Cryptographic Provider', ueberlappungTage: 42, adminsRegistrieren: true };
export const EKU_SERVER = '1.3.6.1.5.5.7.3.1';
/** Spec Pos. 11: nur ServerAuthentication, KU DigitalSignature+KeyEncipherment, Legacy-CSP SChannel, AT_KEYEXCHANGE, Renewal 8 Wochen, Registrieren nur SQL01$/SQL02$ */
export function profilSqlTls(gruppe: { name: string; ou: string; mitglieder: string[] }): VorlagenProfil {
  return { eku: EKU_SERVER, ku: [0xa0, 0x00], keySpec: 1, csp: '1,Microsoft RSA SChannel Cryptographic Provider', ueberlappungTage: 56, adminsRegistrieren: false, maschine: true, gruppe };
}
const CN_FREI = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,62}$/;

export interface VorlageParameter { vorlage: string; anzeige: string; gueltig_tage: number; schluessel_bits: number }
export function pruefeVorlage(o: Record<string, unknown>): VorlageParameter | string {
  const r = { vorlage: String(o.vorlage ?? '').trim(), anzeige: String(o.anzeige ?? '').trim(), gueltig_tage: o.gueltig_tage === undefined ? 365 : Number(o.gueltig_tage), schluessel_bits: o.schluessel_bits === undefined ? 3072 : Number(o.schluessel_bits) };
  if (!VORLAGE.test(r.vorlage)) return 'vorlage: interner Name ohne Leerzeichen, z. B. AD3033AlfredCodesignatur';
  if (!CN_FREI.test(r.anzeige)) return 'anzeige: Anzeigename, z. B. „AD3033 Alfred Codesignatur“';
  if (!Number.isInteger(r.gueltig_tage) || r.gueltig_tage < 30 || r.gueltig_tage > 730) return 'gueltig_tage: 30–730 (Standard 365)';
  if (![3072, 4096].includes(r.schluessel_bits)) return 'schluessel_bits: 3072 oder 4096';
  return r;
}

/** 100-ns-Intervalle als negative Ganzzahl in 8 Bytes (pKIExpirationPeriod/pKIOverlapPeriod) */
const PERIODE = (tage: string) => `[BitConverter]::GetBytes([long](-1 * ${tage} * 864000000000))`;

/**
 * Vorlage anlegen (falls nicht vorhanden) und auf der CA ausstellen — als Domänen-Administrator (ADSI in der Konfigurations-
 * partition, certutil -SetCATemplates). Wiederholbar: eine vorhandene Vorlage mit demselben Anzeigenamen bleibt unverändert.
 */
export function vorlageAnlegenSkript(v0: VorlageParameter & { ausKonto?: string; profil?: VorlagenProfil }): string {
  const v = { ...v0, profil: v0.profil ?? PROFIL_CODESIGNATUR };
  const innen = innenSkript(v, [
    // v1852 — Registrier-Gruppe (SQL-TLS): anlegen, falls nötig; Mitglieder müssen genau die vorgesehenen Computerkonten sein
    '$gruppeSid = $null; $gruppeMitglieder = @()',
    'if ($p.profil.gruppe) {',
    "  $domDn = ([adsi]'LDAP://RootDSE').defaultNamingContext",
    "  function Finde($sam) { $s = New-Object DirectoryServices.DirectorySearcher([adsi]('LDAP://' + $domDn), ('(sAMAccountName=' + $sam + ')')); $r = $s.FindOne(); if ($r) { $r.GetDirectoryEntry() } else { $null } }",
    '  $g = Finde $p.profil.gruppe.name',
    '  if (-not $g) {',
    "    $ou = [adsi]('LDAP://OU=' + $p.profil.gruppe.ou + ',' + $domDn)",
    "    $g = $ou.Create('group', ('CN=' + $p.profil.gruppe.name)); $g.Put('sAMAccountName', $p.profil.gruppe.name); $g.Put('groupType', -2147483646)",
    "    $g.Put('description', ('Registrieren der Vorlage ' + $p.vorlage + ' (Alfred PKI)')); $g.SetInfo()",
    '  }',
    "  foreach ($m in @($p.profil.gruppe.mitglieder)) { $c = Finde $m; if (-not $c) { throw ('Computerkonto ' + $m + ' nicht gefunden') }; $mdn = [string]$c.distinguishedName.Value; if (@($g.Properties['member']) -notcontains $mdn) { [void]$g.Properties['member'].Add($mdn); $g.CommitChanges() } }",
    "  $g.RefreshCache(); $gruppeMitglieder = @($g.Properties['member'] | ForEach-Object { [string]([adsi]('LDAP://' + $_)).Properties['sAMAccountName'].Value })",
    "  $fremd = @($gruppeMitglieder | Where-Object { @($p.profil.gruppe.mitglieder) -notcontains $_ }); if ($fremd.Count) { throw ('Gruppe ' + $p.profil.gruppe.name + ' hat weitere Mitglieder: ' + ($fremd -join ', ') + ' — nichts verändert') }",
    "  $gruppeSid = New-Object Security.Principal.SecurityIdentifier ([byte[]]$g.Properties['objectSid'].Value, 0)",
    '}',
    "$cfg = ([adsi]'LDAP://RootDSE').configurationNamingContext",
    "$pks = 'CN=Public Key Services,CN=Services,' + $cfg",
    "$dn = 'CN=' + $p.vorlage + ',CN=Certificate Templates,' + $pks",
    "$zustand = 'schon vorhanden'",
    "$sollFlags = 131616 -bor $(if ($p.profil.maschine) { 0x40 } else { 0 })",
    "if ([adsi]::Exists('LDAP://' + $dn)) {",
    "  $t = [adsi]('LDAP://' + $dn)",
    "  if ([string]$t.displayName.Value -ne $p.anzeige) { throw ('Vorlage ' + $p.vorlage + ' gibt es schon mit anderem Anzeigenamen („' + [string]$t.displayName.Value + '“) — nichts verändert') }",
    // v1854 — nur das Benutzer/Computer-Kennzeichen wird an einer vorhandenen Vorlage angeglichen (Revision hoch), sonst nichts
    "  if ([int]$t.flags.Value -ne $sollFlags) { $t.Put('flags', $sollFlags); $t.Put('msPKI-Template-Minor-Revision', ([int]$t.Properties['msPKI-Template-Minor-Revision'].Value + 1)); $t.SetInfo(); $zustand = 'angeglichen (Kennzeichen ' + $sollFlags + ')' }",
    '} else {',
    "  $oidC = [adsi]('LDAP://CN=OID,' + $pks)",
    "  $basis = [string]$oidC.Properties['msPKI-Cert-Template-OID'].Value",
    "  if (-not $basis) { throw 'Basis-OID der Gesamtstruktur fehlt (CN=OID)' }",
    '  $rnd = New-Object Random',
    '  $r1 = $rnd.Next(10000000, 99999999); $r2 = $rnd.Next(10000000, 99999999)',
    "  $oid = $basis + '.' + $r1 + '.' + $r2",
    "  $hex = -join (1..32 | ForEach-Object { '{0:X}' -f $rnd.Next(0, 16) })",
    "  $o = $oidC.Create('msPKI-Enterprise-Oid', ('CN=' + $r2 + '.' + $hex))",
    "  $o.Put('flags', 1); $o.Put('displayName', $p.anzeige); $o.Put('msPKI-Cert-Template-OID', $oid); $o.SetInfo()",
    "  $tc = [adsi]('LDAP://CN=Certificate Templates,' + $pks)",
    "  $t = $tc.Create('pKICertificateTemplate', ('CN=' + $p.vorlage))",
    "  $t.Put('displayName', $p.anzeige)",
    "  $t.Put('flags', $sollFlags)",
    "  $t.Put('revision', 100)",
    "  $t.Put('msPKI-Template-Schema-Version', 2)",
    "  $t.Put('msPKI-Template-Minor-Revision', 1)",
    "  $t.Put('pKIDefaultKeySpec', [int]$p.profil.keySpec)",
    "  $t.Put('pKIKeyUsage', [byte[]]@([byte]$p.profil.ku[0], [byte]$p.profil.ku[1]))",
    "  $t.Put('pKIMaxIssuingDepth', 0)",
    "  $t.Put('pKICriticalExtensions', @('2.5.29.15'))",
    "  $t.Put('pKIExtendedKeyUsage', @([string]$p.profil.eku))",
    "  $t.Put('msPKI-Certificate-Application-Policy', @([string]$p.profil.eku))",
    `  $t.Put('pKIExpirationPeriod', ${PERIODE('[int]$p.gueltig_tage')})`,
    `  $t.Put('pKIOverlapPeriod', ${PERIODE('[int]$p.profil.ueberlappungTage')})`,
    "  $t.Put('pKIDefaultCSPs', @([string]$p.profil.csp))",
    "  $t.Put('msPKI-RA-Signature', 0)",
    // 0x2 CT_FLAG_PEND_ALL_REQUESTS: jede Anforderung wartet auf Freigabe an der CA
    "  $t.Put('msPKI-Enrollment-Flag', 2)",
    "  $t.Put('msPKI-Private-Key-Flag', 0)",
    // 0x1 CT_FLAG_ENROLLEE_SUPPLIES_SUBJECT: der Name kommt aus der Anforderung (Schlüssel entsteht außerhalb der Domäne)
    "  $t.Put('msPKI-Certificate-Name-Flag', 1)",
    "  $t.Put('msPKI-Minimal-Key-Size', [int]$p.schluessel_bits)",
    "  $t.Put('msPKI-Cert-Template-OID', $oid)",
    '  $t.SetInfo()',
    // Registrieren nur für Domänen-Admins (Ausstellen danach nur nach Freigabe an der CA)
    '  $dom = [Security.Principal.WindowsIdentity]::GetCurrent().User.AccountDomainSid',
    '  $da = New-Object Security.Principal.SecurityIdentifier ([Security.Principal.WellKnownSidType]::AccountDomainAdminsSid, $dom)',
    '  $t = [adsi](\'LDAP://\' + $dn); $sec = $t.ObjectSecurity',
    `  if ($p.profil.adminsRegistrieren) { $sec.AddAccessRule((New-Object DirectoryServices.ActiveDirectoryAccessRule($da, [DirectoryServices.ActiveDirectoryRights]::ExtendedRight, [Security.AccessControl.AccessControlType]::Allow, [guid]'${ENROLL_RECHT}'))) }`,
    `  if ($gruppeSid) { $sec.AddAccessRule((New-Object DirectoryServices.ActiveDirectoryAccessRule($gruppeSid, [DirectoryServices.ActiveDirectoryRights]::GenericRead, [Security.AccessControl.AccessControlType]::Allow))); $sec.AddAccessRule((New-Object DirectoryServices.ActiveDirectoryAccessRule($gruppeSid, [DirectoryServices.ActiveDirectoryRights]::ExtendedRight, [Security.AccessControl.AccessControlType]::Allow, [guid]'${ENROLL_RECHT}'))) }`,
    '  $t.ObjectSecurity = $sec; $t.CommitChanges()',
    "  $zustand = 'angelegt'",
    '}',
    "$t = [adsi]('LDAP://' + $dn)",
    // v1848 — Realfall 13.11. e850f204 Schritt 4: „-band GenericAll“ traf auch reines Lesen (GenericRead überschneidet sich mit
    // GenericAll) und listete Authenticated Users. Registrieren darf, wer Vollzugriff hat oder das erweiterte Recht „Enroll“ (bzw. alle
    // erweiterten Rechte, ObjectType leer).
    `$enroll = @($t.ObjectSecurity.GetAccessRules($true, $true, [Security.Principal.NTAccount]) | Where-Object { $_.AccessControlType -eq 'Allow' -and ((($_.ActiveDirectoryRights -band [DirectoryServices.ActiveDirectoryRights]::GenericAll) -eq [DirectoryServices.ActiveDirectoryRights]::GenericAll) -or ((($_.ActiveDirectoryRights -band [DirectoryServices.ActiveDirectoryRights]::ExtendedRight) -ne 0) -and ($_.ObjectType -eq [guid]'${ENROLL_RECHT}' -or $_.ObjectType -eq [guid]::Empty))) } | ForEach-Object { [string]$_.IdentityReference } | Sort-Object -Unique)`,
    // auf der CA ausstellen; die CA liest die Vorlage aus dem AD — nach dem Anlegen bis zu 5 min warten (Replikation)
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$ca = [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active",
    "if (-not $ca) { throw 'auf diesem Rechner läuft keine CA' }",
    "$aus = ''; $bis = (Get-Date).AddMinutes(5)",
    'do {',
    "  $liste = (& certutil.exe -CATemplates) -join \"`n\"",
    "  if ($liste -match ('(?m)^' + [regex]::Escape($p.vorlage) + ':')) { break }",
    "  $aus = (& certutil.exe -SetCATemplates ('+' + $p.vorlage)) -join ' '",
    '  if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 15 }',
    '} while ((Get-Date) -lt $bis)',
    "$liste = (& certutil.exe -CATemplates) -join \"`n\"",
    "$aufCa = $liste -match ('(?m)^' + [regex]::Escape($p.vorlage) + ':')",
    "if (-not $aufCa) { throw ('Vorlage nicht auf der CA ausgestellt: ' + $aus) }",
    "$t.RefreshCache()",
    "[ordered]@{ zustand = $zustand; flags = [int]$t.flags.Value; vorlage = $p.vorlage; anzeige = [string]$t.displayName.Value; oid = [string]$t.Properties['msPKI-Cert-Template-OID'].Value; ca = $ca; aufCa = $aufCa; registrieren = $enroll; namensFlag = [int]$t.Properties['msPKI-Certificate-Name-Flag'].Value; anmeldeFlag = [int]$t.Properties['msPKI-Enrollment-Flag'].Value; minSchluessel = [int]$t.Properties['msPKI-Minimal-Key-Size'].Value; eku = @($t.Properties['pKIExtendedKeyUsage'] | ForEach-Object { [string]$_ }); keySpec = [int]$t.Properties['pKIDefaultKeySpec'].Value; csp = @($t.Properties['pKIDefaultCSPs'] | ForEach-Object { [string]$_ }); privatFlag = [int]$t.Properties['msPKI-Private-Key-Flag'].Value; gruppeMitglieder = $gruppeMitglieder }",
  ]);
  return domaenenAdmin(v, innen, 600);
}

/** Rückweg: Vorlage von der CA nehmen, Vorlage und ihr OID-Objekt löschen (nur mit genau diesem Anzeigenamen). */
export function vorlageEntfernenSkript(v: { vorlage: string; anzeige: string; ausKonto?: string }): string {
  const innen = innenSkript(v, [
    "$cfg = ([adsi]'LDAP://RootDSE').configurationNamingContext",
    "$pks = 'CN=Public Key Services,CN=Services,' + $cfg",
    "$dn = 'CN=' + $p.vorlage + ',CN=Certificate Templates,' + $pks",
    "$liste = (& certutil.exe -CATemplates) -join \"`n\"",
    "$vonCa = $false; if ($liste -match ('(?m)^' + [regex]::Escape($p.vorlage) + ':')) { $aus = (& certutil.exe -SetCATemplates ('-' + $p.vorlage)) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('certutil -SetCATemplates: ' + $aus) }; $vonCa = $true }",
    "$geloescht = $false; $oidWeg = $false",
    "if ([adsi]::Exists('LDAP://' + $dn)) {",
    "  $t = [adsi]('LDAP://' + $dn)",
    "  if ([string]$t.displayName.Value -ne $p.anzeige) { throw ('Vorlage ' + $p.vorlage + ' trägt einen anderen Anzeigenamen — nicht gelöscht') }",
    "  $oid = [string]$t.Properties['msPKI-Cert-Template-OID'].Value",
    '  $t.DeleteTree(); $geloescht = $true',
    "  $oidC = [adsi]('LDAP://CN=OID,' + $pks)",
    "  foreach ($c in @($oidC.Children)) { if ([string]$c.Properties['msPKI-Cert-Template-OID'].Value -eq $oid) { $c.DeleteTree(); $oidWeg = $true } }",
    '}',
    "[ordered]@{ vorlage = $p.vorlage; vonCa = $vonCa; geloescht = $geloescht; oidWeg = $oidWeg; nochDa = [adsi]::Exists('LDAP://' + $dn) }",
  ]);
  return domaenenAdmin(v, innen, 300);
}

export interface AusstellParameter { vorlage: string; csr_sha256: string; erwartet_cn: string; ausKonto?: string }
/**
 * Anforderung (Base64 über stdin) hashgeprüft einreichen, als CA-Verwalter freigeben (resubmit) und abholen. Ergebnis: Zertifikat
 * und CA-Zertifikat (DER Base64), RequestId. Prüfen von Schlüssel, Verwendung und Aussteller macht der Alfred-Server danach.
 */
export function ausstellenSkript(a: AusstellParameter): string {
  const innen = innenSkript(a, [
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'",
    "$req = Join-Path $dir 'codesignatur.req'; $cer = Join-Path $dir 'codesignatur.cer'; $cacer = Join-Path $dir 'codesignatur-ca.cer'",
    // v1848 — Realfall 13.11. e850f204 Schritt 5: certreq -retrieve -q weigerte sich, die beim Einreichen entstandene .rsp zu
    // überschreiben (ERROR_FILE_EXISTS) — die Anforderung war ausgestellt, aber nicht abgeholt. -f überschreibt; die RequestId wird
    // je Anforderung (Hash) gemerkt, ein Wiederholen holt dieselbe Anforderung ab statt eine neue einzureichen.
    "Remove-Item -LiteralPath $cer, $cacer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "$idf = Join-Path $dir ('codesignatur-' + $p.csr_sha256.Substring(0, 16) + '.id')",
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$ca = [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active",
    "if (-not $ca) { throw 'auf diesem Rechner läuft keine CA' }",
    "$konfig = [Net.Dns]::GetHostEntry('').HostName + '\\' + $ca",
    "$wieder = Test-Path -LiteralPath $idf",
    "if ($wieder) { $id = ([IO.File]::ReadAllText($idf)).Trim() } else {",
    "  $aus = (& certreq.exe -submit -f -q -config $konfig -attrib ('CertificateTemplate:' + $p.vorlage) $req $cer) -join ' '",
    "  $id = [regex]::Match($aus, 'RequestId:\\s*\"?(\\d+)').Groups[1].Value",
    "  if (-not $id) { throw ('certreq -submit: ' + $aus) }",
    "  [IO.File]::WriteAllText($idf, $id)",
    '}',
    "if (-not (Test-Path -LiteralPath $cer)) { $null = & certreq.exe -retrieve -f -q -config $konfig $id $cer }",
    "if (-not (Test-Path -LiteralPath $cer)) {",
    "  $f = (& certutil.exe -config $konfig -resubmit $id) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('certutil -resubmit ' + $id + ': ' + $f) }",
    "  $g = (& certreq.exe -retrieve -f -q -config $konfig $id $cer) -join ' '; if (-not (Test-Path -LiteralPath $cer)) { throw ('certreq -retrieve ' + $id + ': ' + $g) }",
    '}',
    // v1849 — Realfall 13.11. e850f204 Schritt 5 (2. Lauf): Windows PowerShell 5.1 zerlegt -ca.cert bei externen Programmen in
    // „-ca“ und „.cert“ — certutil gab nur seine Hilfe aus. Argumente mit Punkt immer in Anführungszeichen.
    "$h = (& certutil.exe '-ca.cert' $cacer) -join ' '; if (-not (Test-Path -LiteralPath $cacer)) { throw ('certutil -ca.cert: ' + $h) }",
    "function Der($f) { $t = [IO.File]::ReadAllText($f); if ($t -match '-----BEGIN') { ($t -replace '-----[^-]+-----', '' -replace '\\s', '') } else { [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) } }",
    "$z = Der $cer; $c = Der $cacer",
    "Remove-Item -LiteralPath $req, $cer, $cacer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "[ordered]@{ requestId = [int]$id; ca = $ca; zertBase64 = $z; caBase64 = $c; wiederholt = $wieder }",
  ]);
  return [
    ...kopf(a, true),
    '$shaF = [Security.Cryptography.SHA256]::Create()',
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$b = [Convert]::FromBase64String([string]$e.csr_base64)",
    "$h = (($shaF.ComputeHash($b)) | ForEach-Object { $_.ToString('x2') }) -join ''",
    "if ($h -ne $p.csr_sha256) { throw 'Anforderung passt nicht zum Hash — nichts eingereicht' }",
    "[IO.File]::WriteAllText((Join-Path $dir 'codesignatur.req'), ('-----BEGIN NEW CERTIFICATE REQUEST-----' + \"`r`n\" + ([Convert]::ToBase64String($b, 'InsertLineBreaks')) + \"`r`n\" + '-----END NEW CERTIFICATE REQUEST-----' + \"`r`n\"), [Text.Encoding]::ASCII)",
    MIT_KONTO,
    '$nb = DomaeneNetbios',
    `$w = MitKonto (${kontoAusdruck('Administrator', '$nb')}) $e.kennwort ${psText(innen)} 420`,
    'Ergebnis $w',
  ].join('\n');
}

function domaenenAdmin(p: { ausKonto?: string }, innen: string, sekunden: number): string {
  return [
    ...kopf(p, true),
    MIT_KONTO,
    '$nb = DomaeneNetbios',
    `$w = MitKonto (${kontoAusdruck('Administrator', '$nb')}) $e.kennwort ${psText(innen)} ${sekunden}`,
    'Ergebnis $w',
  ].join('\n');
}

// ── Alfred-Server: Schlüssel, Anforderung, Prüfung, Signatur ─────────────────────────────────────────────────────────────

export type Lokal = (befehl: 'openssl' | 'osslsigncode', args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Arbeitsordner nur für den Alfred-Prozess (700), wird in jedem Fall wieder gelöscht */
export async function mitArbeitsordner<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-cs-'));
  try { await chmod(dir, 0o700); return await f(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

/** RSA-Schlüssel und Anforderung (DER) auf dem Alfred-Server; der Schlüssel verlässt den Server nie */
export async function schluesselUndAnforderung(lokal: Lokal, cn: string, o: string | undefined, bits: number): Promise<{ schluesselPem: string; csrDer: Buffer }> {
  if (!CN_FREI.test(cn) || (o !== undefined && !CN_FREI.test(o))) throw new Error('Name des Zertifikats: 3–63 Zeichen ohne Sonderzeichen');
  return mitArbeitsordner(async dir => {
    const k = join(dir, 'k.pem'); const r = join(dir, 'r.der');
    const a = await lokal('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', `rsa_keygen_bits:${bits}`, '-out', k]);
    if (a.code !== 0) throw new Error(`openssl genpkey: ${a.stderr.trim().slice(-200)}`);
    await chmod(k, 0o600);
    const b = await lokal('openssl', ['req', '-new', '-key', k, '-subj', `/CN=${cn}${o ? `/O=${o}` : ''}`, '-sha256', '-outform', 'DER', '-out', r]);
    if (b.code !== 0) throw new Error(`openssl req: ${b.stderr.trim().slice(-200)}`);
    return { schluesselPem: await readFile(k, 'utf8'), csrDer: await readFile(r) };
  });
}

const fp = (x: X509Certificate) => x.fingerprint.replace(/:/g, '').toUpperCase();
/** Zertifikat gegen Schlüssel, Name, Verwendung, Laufzeit und erwarteten Aussteller prüfen; liefert die Kette als PEM */
export function pruefeAusgestellt(o: { schluesselPem: string; zertBase64: string; caBase64: string; erwartet_cn: string; erwartet_aussteller_thumbprint: string; jetzt?: Date }): { kettePem: string; seriennummer: string; thumbprint: string; gueltigBis: string; tage: number; aussteller: string } {
  const z = new X509Certificate(Buffer.from(o.zertBase64, 'base64'));
  const ca = new X509Certificate(Buffer.from(o.caBase64, 'base64'));
  const pub = createPublicKey(o.schluesselPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (!pub.equals(z.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)) throw new Error('Zertifikat gehört nicht zum Schlüssel');
  if (!z.subject.split('\n').includes(`CN=${o.erwartet_cn}`)) throw new Error(`Name im Zertifikat „${z.subject.replace(/\n/g, ', ')}“ statt CN=${o.erwartet_cn}`);
  if (!(z.keyUsage ?? []).includes(EKU_CODESIGNATUR)) throw new Error(`Zertifikat ohne Verwendung Codesignatur (${(z.keyUsage ?? []).join(', ') || 'keine'})`);
  if (fp(ca) !== o.erwartet_aussteller_thumbprint.replace(/\s/g, '').toUpperCase()) throw new Error(`CA-Zertifikat ${fp(ca)} ist nicht die erwartete Issuing-CA ${o.erwartet_aussteller_thumbprint}`);
  if (!z.checkIssued(ca) || !z.verify(ca.publicKey)) throw new Error('Zertifikat nicht von der erwarteten Issuing-CA signiert');
  const jetzt = o.jetzt ?? new Date();
  const bis = new Date(z.validTo); const ab = new Date(z.validFrom);
  if (!(ab.getTime() <= jetzt.getTime() + 300_000 && bis.getTime() > jetzt.getTime())) throw new Error(`Zertifikat nicht gültig (${z.validFrom} – ${z.validTo})`);
  return { kettePem: `${z.toString()}${ca.toString()}`, seriennummer: z.serialNumber.toLowerCase(), thumbprint: fp(z), gueltigBis: bis.toISOString(), tage: Math.floor((bis.getTime() - jetzt.getTime()) / 86_400_000), aussteller: ca.subject.replace(/\n/g, ', ') };
}

export interface SignaturMaterial { schluesselPem: string; kettePem: string }

/** Ablage im Datenordner: schluessel.pem (600), kette.pem, zustand.json ({ an }); Ordner 700, Schreiben über Umbenennen */
export class CodesignaturAblage {
  constructor(private readonly ordner: string) {}
  private pfad(n: string) { return join(this.ordner, n); }
  private async schreibe(n: string, inhalt: string): Promise<void> {
    await mkdir(this.ordner, { recursive: true, mode: 0o700 }); await chmod(this.ordner, 0o700);
    const tmp = this.pfad(`.${n}.neu`);
    await writeFile(tmp, inhalt, { mode: 0o600 }); await chmod(tmp, 0o600); await rename(tmp, this.pfad(n));
  }
  private async lies(n: string): Promise<string | undefined> {
    try { return await readFile(this.pfad(n), 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
  }
  async an(): Promise<boolean> { const z = await this.lies('zustand.json'); return !!z && (JSON.parse(z) as { an?: unknown }).an === true; }
  async setzeAn(an: boolean): Promise<void> { await this.schreibe('zustand.json', JSON.stringify({ an, geaendert: new Date().toISOString() })); }
  kette(): Promise<string | undefined> { return this.lies('kette.pem'); }
  async material(): Promise<SignaturMaterial> {
    const [schluesselPem, kettePem] = await Promise.all([this.lies('schluessel.pem'), this.lies('kette.pem')]);
    if (!schluesselPem || !kettePem) throw new Error('Codesignatur-Material fehlt (erst codesignatur_einrichten)');
    return { schluesselPem, kettePem };
  }
  async speichere(m: SignaturMaterial): Promise<void> { await this.schreibe('schluessel.pem', m.schluesselPem); await this.schreibe('kette.pem', m.kettePem); }
  async entferne(): Promise<void> { for (const n of ['schluessel.pem', 'kette.pem']) await rm(this.pfad(n), { force: true }); }
  /** v1848 — Schlüssel + Anforderung VOR dem Einreichen ablegen: scheitert das Abholen, holt ein Wiederholen dieselbe Anforderung ab */
  async ausstehend(): Promise<Ausstehend | undefined> { const t = await this.lies('ausstehend.json'); return t ? JSON.parse(t) as Ausstehend : undefined; }
  async speichereAusstehend(a: Ausstehend): Promise<void> { await this.schreibe('ausstehend.json', JSON.stringify(a)); }
  async loescheAusstehend(): Promise<void> { await rm(this.pfad('ausstehend.json'), { force: true }); }
}
export interface Ausstehend { cn: string; o?: string; bits: number; schluesselPem: string; csrBase64: string; erstellt: string }

/** v1848 — Seriennummer zu einer RequestId (Realfall e850f204: Anforderung 3 ausgestellt, Schlüssel verloren → sperren) */
export function seriennummerSkript(a: { request_id: number; erwartet_cn: string }): string {
  return [
    ...kopf(a, false),
    "$v = (& certutil.exe -view -restrict ('RequestId=' + [int]$p.request_id) -out 'RequestId,SerialNumber,CommonName,Disposition' csv) -join \"`n\"",
    "$z = @($v -split \"`n\" | Where-Object { $_ -match ('^\"?' + [int]$p.request_id + '\"?,') })",
    "if ($z.Count -ne 1) { throw ('Anforderung ' + $p.request_id + ' nicht eindeutig in der CA-Datenbank (' + $z.Count + ' Treffer): ' + $v) }",
    "$f = @($z[0] -split ',' | ForEach-Object { $_.Trim().Trim('\"') })",
    "if ($f[2] -ne $p.erwartet_cn) { throw ('Anforderung ' + $p.request_id + ' gehört zu „' + $f[2] + '“, nicht „' + $p.erwartet_cn + '“') }",
    "Ergebnis ([ordered]@{ requestId = [int]$f[0]; seriennummer = ($f[1] -replace '\\s', '').ToLower(); cn = $f[2]; zustand = $f[3] })",
  ].join('\n');
}

/** Erstes Zertifikat einer PEM-Kette */
export function ersteZertifikat(kettePem: string): X509Certificate {
  const ende = kettePem.indexOf('-----END CERTIFICATE-----');
  if (ende < 0) throw new Error('Kette ohne Zertifikat');
  return new X509Certificate(kettePem.slice(0, ende + 25));
}
export interface CodesigniererDeps {
  /** Schalter (Datei im Datenordner); aus = unsigniert wie bisher */
  aktiv: () => Promise<boolean>;
  material: () => Promise<SignaturMaterial>;
  lokal: Lokal;
  melde?: (text: string) => void;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  jetzt?: () => number;
}

/**
 * Signiert Skriptdateien vor dem Hochladen und bewertet den Status, den der Zielrechner vor dem Start liest. Das Material wird
 * 15 Minuten im Speicher gehalten.
 */
export class Codesignierer {
  private cache?: { m: SignaturMaterial; bis: number; gueltigBis: number };
  private letzteWarnung = 0;
  readonly zaehler: Record<string, number> = {};
  /** nach Einrichten, Sperren oder Schalten: Material neu laden */
  vergiss(): void { this.cache = undefined; }
  constructor(private readonly d: CodesigniererDeps) {}
  private jetzt() { return this.d.jetzt?.() ?? Date.now(); }

  private async stoff(): Promise<SignaturMaterial> {
    if (this.cache && this.cache.bis > this.jetzt()) return this.cache.m;
    const m = await this.d.material();
    const z = ersteZertifikat(m.kettePem);
    this.cache = { m, bis: this.jetzt() + 15 * 60_000, gueltigBis: new Date(z.validTo).getTime() };
    return m;
  }

  /** Signierter Inhalt, oder null, wenn die Codesignatur ausgeschaltet ist (erzwingen: Selbsttest vor dem Einschalten) */
  async signiere(inhalt: string, erzwingen = false): Promise<string | null> {
    if (!erzwingen && !(await this.d.aktiv())) return null;
    const m = await this.stoff();
    const tage = Math.floor((this.cache!.gueltigBis - this.jetzt()) / 86_400_000);
    if (tage < 0) throw new Error('Codesignatur-Zertifikat ist abgelaufen — erst erneuern (Change) oder die Codesignatur ausschalten');
    if (tage <= 30 && this.jetzt() - this.letzteWarnung > 86_400_000) {
      this.letzteWarnung = this.jetzt();
      this.d.melde?.(`🔏 Das Codesignatur-Zertifikat von Alfred läuft in ${tage} Tagen ab (${new Date(this.cache!.gueltigBis).toISOString().slice(0, 10)}). Bitte die Erneuerung als Change planen.`);
    }
    return mitArbeitsordner(async dir => {
      const k = join(dir, 'k.pem'); const c = join(dir, 'c.pem'); const ein = join(dir, 'ein.ps1'); const aus = join(dir, 'aus.ps1');
      await writeFile(k, m.schluesselPem, { mode: 0o600 });
      await writeFile(c, m.kettePem, { mode: 0o600 });
      await writeFile(ein, inhalt, 'utf8');
      const r = await this.d.lokal('osslsigncode', ['sign', '-certs', c, '-key', k, '-h', 'sha256', '-in', ein, '-out', aus]);
      if (r.code !== 0) throw new Error(`Signieren gescheitert (osslsigncode ${r.code}): ${r.stderr.trim().slice(-200)}`);
      return readFile(aus, 'utf8');
    });
  }

  /** Status, den der Zielrechner vor dem Start gelesen hat: Abbruch bei Veränderung, sonst zählen und protokollieren */
  bewerte(statusRoh: string, wo: string): string {
    const s = statusRoh.trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean).pop() ?? '';
    const status = SIGNATUR_STATUS.has(s) ? s : 'unbekannt';
    this.zaehler[status] = (this.zaehler[status] ?? 0) + 1;
    this.d.protokoll?.('Codesignatur geprüft', { wo, status });
    if (SIGNATUR_ABBRUCH.has(status)) throw new Error(`Signaturprüfung auf ${wo}: ${status} — die Skriptdatei wurde nach dem Signieren verändert; nicht ausgeführt`);
    return status;
  }

  /** v1846 — Ausdruck für die Prüfung vor dem Start (SSH-Standardshell PowerShell bzw. Gastagent-Argument) */
  static pruefAusdruck(pfadWindows: string): string {
    if (!/^C:\\Windows\\Temp\\alfred-s-[0-9a-f]{16}\.ps1$/.test(pfadWindows)) throw new Error('unerwarteter Skriptpfad');
    return `(Get-AuthenticodeSignature -LiteralPath ${pfadWindows}).Status.ToString()`;
  }
}
