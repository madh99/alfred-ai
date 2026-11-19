/**
 * I8e Etappe 3 Task 3 — SQL-TLS-Zertifikate für die Linux-SQL-Hosts (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md):
 *   - Vorlage AD3033-SQL-TLS-Linux-v1 („AD3033 SQL TLS Linux v1“): wie AD3033-SQL-TLS-v1 nur ServerAuthentication, KU DigitalSignature+
 *     KeyEncipherment, RSA ≥ 3072, 365 Tage, Erneuerung 8 Wochen, Name aus der Anforderung nur mit CA-Freigabe — aber Benutzer-Vorlage
 *     ohne CSP-, KeySpec- und Export-Vorgabe: der Schlüssel entsteht als Datei auf dem Linux-Host und verlässt ihn nie. Registrieren nur
 *     die Gruppe PKI-SQL-TLS-Linux-Registrieren mit genau svc-pki-linuxreq.
 *   - fremd_csr_ausstellen (auf der Issuing-CA): die Anforderung (CSR, öffentlich) kommt über stdin. Vor dem Einreichen prüft der Baustein
 *     mit dem COM-Objekt X509Enrollment.CX509CertificateRequestPkcs10 SHA-256, Subject, SAN-Liste exakt und RSA ≥ 3072 — sonst Ergebnis
 *     „fehler“, nichts eingereicht. Dann einreichen als svc-pki-linuxreq (Kennwort stdin), genehmigen mit dem Baustein von
 *     sql_tls_genehmigen (Anforderer exakt AD3033\svc-pki-linuxreq, Vorlage, Subject, Bits, SAN-Allowlist), abholen, Selbstprüfung
 *     (Schlüssel = Anforderung, Kette bis zur Root, SAN, EKU). Wiederholbar: eine schon eingereichte Anforderung mit demselben SHA-256
 *     (CA-Datenbank, derselbe Anforderer) wird weiterverwendet, eine schon ausgestellte nur abgeholt.
 */
import { createHash } from 'node:crypto';
import { kopf, psText } from './windows-ad.js';
import { MIT_KONTO, innenSkript } from './windows-cluster.js';
import { ALS_BENUTZER } from './windows-ad-linux.js';
import { EKU_SERVER, type VorlagenProfil } from './windows-codesignatur.js';
import { CA_KONFIG_LESEN, CSR_INHALT, CSR_BEFUNDE, GENEHMIGEN_PRUEFEN } from './windows-sqltls.js';

export const SQL_TLS_LINUX_VORLAGE = 'AD3033-SQL-TLS-Linux-v1';
export const SQL_TLS_LINUX_ANZEIGE = 'AD3033 SQL TLS Linux v1';
export const SQL_TLS_LINUX_GRUPPE = 'PKI-SQL-TLS-Linux-Registrieren';
export const SQL_TLS_LINUX_KONTO = 'svc-pki-linuxreq';
export const SQL_TLS_LINUX_TRESOR = 'ad-svc-pki-linuxreq';
export const SQL_TLS_LINUX_ANFORDERER = `AD3033\\${SQL_TLS_LINUX_KONTO}`;
const DOMAENE = 'ad.3033.at';
const LISTENER = 'sqllnxag01';

/** Global Constraints: SANs je Host genau — sqllnx01/02 mit dem Listener, sqllnxcfg nur sich selbst; sonst undefined */
export function linuxTlsSans(host: string): string[] | undefined {
  if (host === 'sqllnx01' || host === 'sqllnx02') return [host, `${host}.${DOMAENE}`, LISTENER, `${LISTENER}.${DOMAENE}`];
  if (host === 'sqllnxcfg') return [host, `${host}.${DOMAENE}`];
  return undefined;
}

/** Profil der Linux-Vorlage (Werte gehen als JSON in vorlageAnlegenSkript): keine CSP-Vorgabe, Benutzer-Vorlage, Gruppe mit genau svc-pki-linuxreq */
export function profilSqlTlsLinux(ou: string): VorlagenProfil {
  return { eku: EKU_SERVER, ku: [0xa0, 0x00], keySpec: 1, csp: '', ueberlappungTage: 56, adminsRegistrieren: false, maschine: false, gruppe: { name: SQL_TLS_LINUX_GRUPPE, ou, mitglieder: [SQL_TLS_LINUX_KONTO] } };
}

export const CSR_MAX_BYTES = 8192;
const CSR_PEM = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n((?:[A-Za-z0-9+/=]{1,76}\r?\n)+)-----END CERTIFICATE REQUEST-----\r?\n$/;

/** Nur die PEM-Form (ein Block, Base64, DER-SEQUENCE, ≤ 8 KB) — den Inhalt prüft der Baustein auf der CA (Node hat keinen CSR-Parser) */
export function pruefeCsrForm(csrPem: string): string | undefined {
  if (typeof csrPem !== 'string' || !csrPem.trim()) return 'csr_pem: Anforderung (PEM) fehlt';
  if (Buffer.byteLength(csrPem, 'utf8') > CSR_MAX_BYTES) return 'csr_pem: Anforderung größer als 8 KB';
  const m = CSR_PEM.exec(`${csrPem.trim()}\n`);
  if (!m) return 'csr_pem: erwartet genau einen Block „-----BEGIN CERTIFICATE REQUEST-----“ … „-----END CERTIFICATE REQUEST-----“ mit Base64-Zeilen';
  const b64 = m[1]!.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return 'csr_pem: kein gültiges Base64';
  const der = Buffer.from(b64, 'base64');
  if (der.length < 64 || der[0] !== 0x30) return 'csr_pem: keine DER-kodierte Anforderung (SEQUENCE)';
  return undefined;
}

/** SHA-256 (hex) der DER-Anforderung — derselbe Wert, den tls_anfordern auf dem Linux-Host meldet */
export function csrSha256(csrPem: string): string {
  const b64 = csrPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

export interface FremdAusstellung { cn: string; sans: string[]; csr_sha256: string; csrPem: string }
export function pruefeFremdAusstellung(o: Record<string, unknown>): FremdAusstellung | string {
  const cn = String(o.cn ?? '').trim().toLowerCase();
  const host = cn.endsWith(`.${DOMAENE}`) ? cn.slice(0, -(DOMAENE.length + 1)) : '';
  const soll = linuxTlsSans(host);
  if (!soll) return `cn: FQDN eines Linux-SQL-Hosts — sqllnx01.${DOMAENE}, sqllnx02.${DOMAENE} oder sqllnxcfg.${DOMAENE}`;
  const sans = (Array.isArray(o.sans) ? o.sans : []).map(x => String(x).trim().toLowerCase());
  if (new Set(sans).size !== sans.length || [...sans].sort().join(',') !== [...soll].sort().join(',')) return `sans: genau ${soll.join(', ')} (Reihenfolge egal)`;
  const sha = String(o.csr_sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) return 'csr_sha256: SHA-256 der Anforderung (64 Hex) aus linux_sql tls_anfordern';
  const csrPem = typeof o.csr_pem === 'string' ? o.csr_pem : '';
  const form = pruefeCsrForm(csrPem); if (form) return form;
  if (csrSha256(csrPem) !== sha) return 'csr_sha256 passt nicht zur Anforderung (csr_pem) — nichts eingereicht';
  return { cn, sans: soll, csr_sha256: sha, csrPem };
}

/** Platzhalter, die das äußere Skript zur Laufzeit im Skript für svc-pki-linuxreq ersetzt (beide Werte Base64: JSON- und PS-sicher) */
const PLATZ_CSR = 'ALFRED-CSR-BASE64';
const PLATZ_KONFIG = 'ALFRED-KONFIG-BASE64';

/** Als SYSTEM in der CA-Datenbank: Anforderungen von $p.anforderer mit SHA-256 = $p.csr_sha256 → $fund (ausgestellt vor ausstehend, neueste) */
const SUCHEN = [
  "$v = New-Object -ComObject CertificateAuthority.View; $v.OpenConnection($konfig)",
  "$spalten = @('RequestID', 'Request.RequesterName', 'Request.Disposition', 'Request.RawRequest')",
  '$v.SetResultColumnCount($spalten.Count); foreach ($s in $spalten) { $v.SetResultColumn($v.GetColumnIndex($false, $s)) }',
  '$shaF = [Security.Cryptography.SHA256]::Create(); $funde = @(); $zeilen = $v.OpenView()',
  "while ($zeilen.Next() -ne -1) { $w = @{}; $sp = $zeilen.EnumCertViewColumn(); while ($sp.Next() -ne -1) { $w[$sp.GetName()] = $sp.GetValue(1) }; if ([string]$w['Request.RequesterName'] -ne [string]$p.anforderer -or -not $w['Request.RawRequest']) { continue }; $h = -join ($shaF.ComputeHash([Convert]::FromBase64String(([string]$w['Request.RawRequest'] -replace '\\s', ''))) | ForEach-Object { $_.ToString('x2') }); if ($h -eq $p.csr_sha256) { $funde += [pscustomobject]@{ id = [int]$w['RequestID']; disp = [int]$w['Request.Disposition'] } } }",
  '$aus20 = @($funde | Where-Object { $_.disp -eq 20 } | Sort-Object id -Descending); $aus9 = @($funde | Where-Object { $_.disp -eq 9 } | Sort-Object id -Descending)',
  '$fund = $(if ($aus20.Count) { $aus20[0] } elseif ($aus9.Count) { $aus9[0] } else { $null })',
];

/**
 * Ausstellen auf der Issuing-CA (zugang pkiiss01). Eingabe stdin { kennwort (svc-pki-linuxreq), csr_pem }. Ergebnis bei einer gescheiterten
 * Prüfung { zustand: 'fehler', fehler } (nichts eingereicht), sonst { zustand: 'ausgestellt' | 'schon ausgestellt', requestId, thumbprint,
 * seriennummer, gueltigBis, subjekt, sans, eku, glieder, anforderer, zertifikatPem, kettePem (Issuing + Root), eingereicht }.
 */
export function fremdAusstellenSkript(a: { cn: string; sans: string[]; csr_sha256: string }): string {
  const p = { cn: a.cn, sans: a.sans, csr_sha256: a.csr_sha256, schluessel_bits: 3072, vorlage: SQL_TLS_LINUX_VORLAGE, anforderer: SQL_TLS_LINUX_ANFORDERER };
  const innenSuchen = innenSkript(p, [...CA_KONFIG_LESEN, ...SUCHEN, "[ordered]@{ id = $(if ($fund) { [int]$fund.id } else { 0 }); disp = $(if ($fund) { [int]$fund.disp } else { 0 }); konfig = $konfig }"]);
  // läuft als svc-pki-linuxreq in einem eigenen Ordner (AlsBenutzer); certreq -submit wartet auf die CA-Freigabe (Vorlage: jede Anforderung)
  const innenEinreichen = innenSkript({ vorlage: p.vorlage, csr: PLATZ_CSR, konfig: PLATZ_KONFIG }, [
    '$dir = Split-Path -Parent $aus',
    '$konfig = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$p.konfig))',
    "$req = Join-Path $dir 'anforderung.req'; $cer = Join-Path $dir 'sofort.cer'",
    "[IO.File]::WriteAllText($req, ('-----BEGIN NEW CERTIFICATE REQUEST-----' + \"`r`n\" + [Convert]::ToBase64String([Convert]::FromBase64String([string]$p.csr), 'InsertLineBreaks') + \"`r`n\" + '-----END NEW CERTIFICATE REQUEST-----' + \"`r`n\"), [Text.Encoding]::ASCII)",
    "$s = (& certreq.exe -submit -q -f -config $konfig -attrib ('CertificateTemplate:' + $p.vorlage) $req $cer) -join ' '",
    "$id = [regex]::Match($s, 'RequestId:\\s*\"?(\\d+)').Groups[1].Value",
    "if (-not $id) { throw ('certreq -submit: ' + $s) }",
    "[ordered]@{ requestId = [int]$id; antwort = ($s -replace '\\s+', ' ').Substring(0, [Math]::Min(200, $s.Length)) }",
  ]);
  const innenAusstellen = innenSkript(p, [
    ...CA_KONFIG_LESEN, ...SUCHEN,
    "if (-not $fund) { throw ('keine ausstehende oder ausgestellte Anforderung von ' + $p.anforderer + ' mit SHA-256 ' + $p.csr_sha256 + ' in der CA-Datenbank') }",
    '$p | Add-Member -NotePropertyName request_id -NotePropertyValue ([int]$fund.id) -Force',
    ...GENEHMIGEN_PRUEFEN,
    "$dir = Join-Path $env:ProgramData 'Alfred\\pki'; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "$cer = Join-Path $dir ('sqltls-linux-' + $p.request_id + '.cer'); Remove-Item -LiteralPath $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    "$g = (& certreq.exe -retrieve -f -q -config $konfig $p.request_id $cer) -join ' '; if (-not (Test-Path -LiteralPath $cer)) { throw ('certreq -retrieve ' + $p.request_id + ': ' + $g) }",
    '$x = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer',
    "Remove-Item -LiteralPath $cer, ($cer -replace '\\.cer$', '.rsp') -Force -ErrorAction SilentlyContinue",
    // Selbstprüfung: Schlüssel des Zertifikats = Schlüssel der Anforderung, Kette bis zur Root, SAN und EKU (bewertet in TS)
    "if ((([string]$r.PublicKey.EncodedKey(1)) -replace '\\s', '') -ne [Convert]::ToBase64String($x.PublicKey.EncodedKeyValue.RawData)) { throw ('Zertifikat ' + $x.Thumbprint + ' gehört nicht zum Schlüssel der Anforderung ' + $p.request_id) }",
    "$ch = New-Object Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode = 'NoCheck'",
    "if (-not $ch.Build($x)) { throw ('Kette zu ' + $x.Thumbprint + ' nicht aufgebaut: ' + (@($ch.ChainStatus | ForEach-Object { [string]$_.Status }) -join ', ')) }",
    '$glieder = @($ch.ChainElements | ForEach-Object { $_.Certificate })',
    "if ($glieder.Count -lt 3 -or $glieder[-1].Subject -ne $glieder[-1].Issuer) { throw ('Kette zu ' + $x.Thumbprint + ' ohne Issuing-CA und Root (' + $glieder.Count + ' Glieder)') }",
    "function Pem($c) { $b = [Convert]::ToBase64String($c.RawData); '-----BEGIN CERTIFICATE-----' + \"`n\" + (($b -split '(.{64})' | Where-Object { $_ }) -join \"`n\") + \"`n\" + '-----END CERTIFICATE-----' + \"`n\" }",
    "$zsans = @(); $ext = $x.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }; if ($ext) { $an2 = New-Object -ComObject X509Enrollment.CX509ExtensionAlternativeNames; $an2.InitializeDecode(1, [Convert]::ToBase64String($ext.RawData)); foreach ($n in $an2.AlternativeNames) { $zsans += $(if ($n.Type -eq 3) { ([string]$n.strValue).ToLower() } else { 'Typ ' + $n.Type }) } }",
    '$eku = @(($x.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }).EnhancedKeyUsages | ForEach-Object { $_.Value })',
    "$zustandAus = $(if ($genehmigt.zustand -eq 'genehmigt') { 'ausgestellt' } else { 'schon ausgestellt' })",
    "[ordered]@{ zustand = $zustandAus; requestId = [int]$p.request_id; thumbprint = $x.Thumbprint; seriennummer = $x.SerialNumber.ToLower(); gueltigBis = $x.NotAfter.ToString('s'); subjekt = $x.Subject; sans = (@($zsans | Sort-Object) -join ','); eku = $eku; glieder = $glieder.Count; anforderer = $genehmigt.anforderer; zertifikatPem = (Pem $x); kettePem = (-join @($glieder | Select-Object -Skip 1 | ForEach-Object { Pem $_ })) }",
  ]);
  return [
    ...kopf(p, true),
    MIT_KONTO,
    ALS_BENUTZER,
    "function Fehler([string]$t) { Ergebnis ([ordered]@{ zustand = 'fehler'; fehler = $t }); exit 0 }",
    // 1. Form und Hash (Review Focus 3: jede Abweichung → nichts eingereicht)
    '$pem = [string]$e.csr_pem',
    "if ($pem.Length -gt 8192 -or $pem -notmatch '^\\s*-----BEGIN CERTIFICATE REQUEST-----[A-Za-z0-9+/=\\s]+-----END CERTIFICATE REQUEST-----\\s*$') { Fehler 'keine PEM-Anforderung (genau ein Block, höchstens 8 KB) — nichts eingereicht' }",
    "$b64 = ($pem -replace '-----[^-]+-----', '') -replace '\\s', ''",
    "try { $der = [Convert]::FromBase64String($b64) } catch { Fehler 'Anforderung ist kein gültiges Base64 — nichts eingereicht' }",
    "$sha = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($der) | ForEach-Object { $_.ToString('x2') })",
    "if ($sha -ne $p.csr_sha256) { Fehler ('SHA-256 der Anforderung ' + $sha + ' statt ' + $p.csr_sha256 + ' — nichts eingereicht') }",
    // 2. Inhalt: Subject, SAN-Liste exakt, RSA ≥ 3072 (gemeinsame Prüfzeilen mit sql_tls_genehmigen)
    "try { $r = New-Object -ComObject X509Enrollment.CX509CertificateRequestPkcs10; $r.InitializeDecode($b64, 1) } catch { Fehler ('Anforderung nicht lesbar: ' + $_.Exception.Message + ' — nichts eingereicht') }",
    ...CSR_INHALT,
    '$gruende = @()',
    "if ([string]$r.PublicKey.Algorithm.Value -ne '1.2.840.113549.1.1.1') { $gruende += ('Schlüsselalgorithmus ' + $r.PublicKey.Algorithm.Value + ' statt RSA') }",
    ...CSR_BEFUNDE,
    "if ($gruende.Count) { Fehler (($gruende -join '; ') + ' — nichts eingereicht') }",
    // 3. schon eingereicht? Sonst als svc-pki-linuxreq einreichen (Kennwort nur aus stdin)
    `$such = MitKonto 'SYSTEM' '' ${psText(innenSuchen)} 180`,
    '$eingereicht = $false',
    'if (-not [int]$such.id) {',
    `  $innenU = ${psText(innenEinreichen)}.Replace(${psText(PLATZ_CSR)}, $b64).Replace(${psText(PLATZ_KONFIG)}, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$such.konfig)))`,
    '  $u = AlsBenutzer $p.anforderer $e.kennwort $innenU 180',
    "  if (-not [int]$u.requestId) { throw ('certreq -submit als ' + $p.anforderer + ' ohne RequestId') }",
    '  $eingereicht = $true',
    '}',
    // 4. genehmigen (Prüfungen von sql_tls_genehmigen, Anforderer exakt), abholen, Selbstprüfung
    `$w = MitKonto 'SYSTEM' '' ${psText(innenAusstellen)} 300`,
    '$w | Add-Member -NotePropertyName eingereicht -NotePropertyValue $eingereicht -Force',
    'Ergebnis $w',
  ].join('\n');
}

export interface FremdAusgestellt {
  zustand: string; fehler?: string; requestId?: number; thumbprint?: string; seriennummer?: string; gueltigBis?: string; subjekt?: string; sans?: string; eku?: string[];
  glieder?: number; anforderer?: string; zertifikatPem?: string; kettePem?: string; eingereicht?: boolean;
}

const PEM_ZERT = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;
/** Selbstprüfung des gemeldeten Ergebnisses gegen die Anforderung (Name, SAN-Liste exakt, nur ServerAuth, Kette, Laufzeit, nur öffentliche Blöcke) */
export function bewerteFremdAusgestellt(r: FremdAusgestellt, a: FremdAusstellung, jetzt = new Date()): string[] {
  const g: string[] = [];
  if (r.zustand !== 'ausgestellt' && r.zustand !== 'schon ausgestellt') g.push(`Zustand ${r.zustand}`);
  if (!Number.isInteger(r.requestId) || (r.requestId ?? 0) < 1) g.push(`RequestId ${String(r.requestId)}`);
  if (!/^[0-9A-F]{40}$/.test(r.thumbprint ?? '')) g.push(`Thumbprint ${r.thumbprint ?? '—'}`);
  if (r.subjekt !== `CN=${a.cn}`) g.push(`Subject ${r.subjekt ?? '—'} statt CN=${a.cn}`);
  const ist = String(r.sans ?? '').split(',').filter(Boolean).sort().join(','); const soll = [...a.sans].sort().join(',');
  if (ist !== soll) g.push(`SAN ${ist || '—'} statt ${soll}`);
  if ((r.eku ?? []).join(',') !== EKU_SERVER) g.push(`EKU ${(r.eku ?? []).join(',') || 'keine'} statt nur ${EKU_SERVER}`);
  const bis = r.gueltigBis ? new Date(r.gueltigBis) : undefined;
  if (!bis || Number.isNaN(bis.getTime()) || bis <= jetzt) g.push(`gültig bis ${r.gueltigBis ?? '—'}`);
  if ((r.glieder ?? 0) < 3) g.push(`Kette mit ${r.glieder ?? 0} Gliedern`);
  if ((String(r.zertifikatPem ?? '').match(PEM_ZERT) ?? []).length !== 1) g.push('Zertifikat nicht genau ein PEM-Block');
  if ((String(r.kettePem ?? '').match(PEM_ZERT) ?? []).length < 2) g.push('Kette ohne Issuing-CA und Root (PEM)');
  if (/PRIVATE KEY/.test(`${r.zertifikatPem ?? ''}${r.kettePem ?? ''}`)) g.push('privater Schlüssel im Ergebnis');
  return g;
}
