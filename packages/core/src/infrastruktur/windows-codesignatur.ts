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

const VORLAGE = /^[A-Za-z][A-Za-z0-9]{2,39}$/;
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
export function vorlageAnlegenSkript(v: VorlageParameter & { ausKonto?: string }): string {
  const innen = innenSkript(v, [
    "$cfg = ([adsi]'LDAP://RootDSE').configurationNamingContext",
    "$pks = 'CN=Public Key Services,CN=Services,' + $cfg",
    "$dn = 'CN=' + $p.vorlage + ',CN=Certificate Templates,' + $pks",
    "$zustand = 'schon vorhanden'",
    "if ([adsi]::Exists('LDAP://' + $dn)) {",
    "  $t = [adsi]('LDAP://' + $dn)",
    "  if ([string]$t.displayName.Value -ne $p.anzeige) { throw ('Vorlage ' + $p.vorlage + ' gibt es schon mit anderem Anzeigenamen („' + [string]$t.displayName.Value + '“) — nichts verändert') }",
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
    "  $t.Put('flags', 131616)",
    "  $t.Put('revision', 100)",
    "  $t.Put('msPKI-Template-Schema-Version', 2)",
    "  $t.Put('msPKI-Template-Minor-Revision', 1)",
    "  $t.Put('pKIDefaultKeySpec', 2)",
    "  $t.Put('pKIKeyUsage', [byte[]](0x80, 0x00))",
    "  $t.Put('pKIMaxIssuingDepth', 0)",
    "  $t.Put('pKICriticalExtensions', @('2.5.29.15'))",
    `  $t.Put('pKIExtendedKeyUsage', @('${EKU_CODESIGNATUR}'))`,
    `  $t.Put('msPKI-Certificate-Application-Policy', @('${EKU_CODESIGNATUR}'))`,
    `  $t.Put('pKIExpirationPeriod', ${PERIODE('[int]$p.gueltig_tage')})`,
    `  $t.Put('pKIOverlapPeriod', ${PERIODE('42')})`,
    "  $t.Put('pKIDefaultCSPs', @('1,Microsoft Enhanced RSA and AES Cryptographic Provider'))",
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
    `  $sec.AddAccessRule((New-Object DirectoryServices.ActiveDirectoryAccessRule($da, [DirectoryServices.ActiveDirectoryRights]::ExtendedRight, [Security.AccessControl.AccessControlType]::Allow, [guid]'${ENROLL_RECHT}')))`,
    '  $t.ObjectSecurity = $sec; $t.CommitChanges()',
    "  $zustand = 'angelegt'",
    '}',
    "$t = [adsi]('LDAP://' + $dn)",
    `$enroll = @($t.ObjectSecurity.GetAccessRules($true, $true, [Security.Principal.NTAccount]) | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.ObjectType -eq [guid]'${ENROLL_RECHT}' -or ($_.ActiveDirectoryRights -band [DirectoryServices.ActiveDirectoryRights]::GenericAll)) } | ForEach-Object { [string]$_.IdentityReference } | Sort-Object -Unique)`,
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
    "[ordered]@{ zustand = $zustand; vorlage = $p.vorlage; anzeige = [string]$t.displayName.Value; oid = [string]$t.Properties['msPKI-Cert-Template-OID'].Value; ca = $ca; aufCa = $aufCa; registrieren = $enroll; namensFlag = [int]$t.Properties['msPKI-Certificate-Name-Flag'].Value; anmeldeFlag = [int]$t.Properties['msPKI-Enrollment-Flag'].Value; minSchluessel = [int]$t.Properties['msPKI-Minimal-Key-Size'].Value }",
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
    "Remove-Item -LiteralPath $cer, $cacer -Force -ErrorAction SilentlyContinue",
    "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration'",
    "$ca = [string](Get-ItemProperty $k -ErrorAction SilentlyContinue).Active",
    "if (-not $ca) { throw 'auf diesem Rechner läuft keine CA' }",
    "$konfig = [Net.Dns]::GetHostEntry('').HostName + '\\' + $ca",
    "$aus = (& certreq.exe -submit -q -config $konfig -attrib ('CertificateTemplate:' + $p.vorlage) $req $cer) -join ' '",
    "$id = [regex]::Match($aus, 'RequestId:\\s*\"?(\\d+)').Groups[1].Value",
    "if (-not $id) { throw ('certreq -submit: ' + $aus) }",
    "if (-not (Test-Path -LiteralPath $cer)) {",
    "  $f = (& certutil.exe -config $konfig -resubmit $id) -join ' '; if ($LASTEXITCODE -ne 0) { throw ('certutil -resubmit ' + $id + ': ' + $f) }",
    "  $g = (& certreq.exe -retrieve -q -config $konfig $id $cer) -join ' '; if (-not (Test-Path -LiteralPath $cer)) { throw ('certreq -retrieve ' + $id + ': ' + $g) }",
    '}',
    "$h = (& certutil.exe -ca.cert $cacer) -join ' '; if (-not (Test-Path -LiteralPath $cacer)) { throw ('certutil -ca.cert: ' + $h) }",
    "function Der($f) { $t = [IO.File]::ReadAllText($f); if ($t -match '-----BEGIN') { ($t -replace '-----[^-]+-----', '' -replace '\\s', '') } else { [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) } }",
    "$z = Der $cer; $c = Der $cacer",
    "Remove-Item -LiteralPath $req, $cer, $cacer -Force -ErrorAction SilentlyContinue",
    "[ordered]@{ requestId = [int]$id; ca = $ca; zertBase64 = $z; caBase64 = $c }",
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

  /** Signierter Inhalt, oder null, wenn die Codesignatur ausgeschaltet ist */
  async signiere(inhalt: string): Promise<string | null> {
    if (!(await this.d.aktiv())) return null;
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
