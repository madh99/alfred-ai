/**
 * I8e Etappe 3 (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md) — AD-Objekte für die Kerberos-Anmeldung an den Linux-SQL-Instanzen:
 * SPNs am Dienstkonto, vorbereitetes Computerkonto mit Einmal-Kennwort, Reverse-DNS, Gruppe, Anmeldeprobe von sql01 aus.
 *
 * Eigene Datei statt windows-ad.ts: die Anmeldeprobe braucht innenSkript aus windows-cluster.ts, und windows-cluster.ts importiert
 * windows-ad.ts (ein Import in die Gegenrichtung wäre ein Kreis, der je nach Ladereihenfolge kontoAusdruck vor der Initialisierung aufruft).
 *
 * Alle Domänen-Operationen am DC laufen mit dem Domänen-Administrator (-Credential $c aus adAdminCred, Kennwort nur über die
 * Standardeingabe) — die SSH-Anmeldung per Schlüssel ist ein S4U-Token ohne Domänengruppen (I8c-Lehre, Realfall 3103ec4c).
 * DNS-Server-Cmdlets laufen dafür über eine CIM-Sitzung mit demselben Konto.
 */
import { kopf, psText, adAdminCred, AD_DOMAENE, IPV4 } from './windows-ad.js';
import { innenSkript } from './windows-cluster.js';

// ── Eingaben ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** SPNs der Linux-SQL-Instanzen (Spec 7.1): MSSQLSvc/<fqdn> und MSSQLSvc/<fqdn>:1433 in ad.3033.at */
export const SPN_LINUX = /^MSSQLSvc\/[a-z0-9.-]+\.ad\.3033\.at(:1433)?$/;
const OU_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;
const DIENSTKONTO = /^[A-Za-z][A-Za-z0-9-]{2,19}$/;
/** NetBIOS-Rechnername (ohne $), höchstens 15 Zeichen */
const COMPUTERNAME = /^[A-Za-z][A-Za-z0-9-]{0,14}$/;
const GRUPPE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
/** Mitglied: sAMAccountName eines Benutzers oder Computers (mit $) */
const MITGLIED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}\$?$/;
const REVERSE_ZONE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){1,3}in-addr\.arpa$/;
/**
 * Fix-Runde 1 (Ruling R5) — die Anmeldeprobe ist lesend (auch außerhalb von Changes), legt aber eine Aufgabe mit gespeichertem Kennwort an:
 * nur gegen Instanzen in ad.3033.at, nur von sql01/sql02, nur mit einem Test-Konto ad-svc-…-test (nie ein Admin-Kennwort im Aufgabenplaner)
 */
const SQL_SERVER = /^[a-z0-9-]+\.ad\.3033\.at$/;
export const SQL_PROBE_ZUGAENGE: ReadonlySet<string> = new Set(['sql01', 'sql02']);
export const SQL_PROBE_TRESOR = /^ad-svc-[a-z0-9-]+-test$/;

export function pruefeSpns(x: unknown): string[] | string {
  const l = Array.isArray(x) ? x.map(v => String(v).trim()).filter(Boolean) : typeof x === 'string' ? x.split(/[,\s]+/).filter(Boolean) : [];
  if (!l.length || l.length > 12) return 'spns: 1–12 SPNs der Form MSSQLSvc/<name>.ad.3033.at oder MSSQLSvc/<name>.ad.3033.at:1433';
  const falsch = l.filter(s => !SPN_LINUX.test(s));
  if (falsch.length) return `spns: ${falsch.join(', ').slice(0, 200)} — erlaubt sind nur MSSQLSvc/<name>.ad.3033.at bzw. …:1433 (Name in Kleinbuchstaben)`;
  return [...new Set(l)];
}

export function pruefeKonto(k: unknown): string | { konto: string } {
  const konto = typeof k === 'string' ? k.trim() : '';
  return DIENSTKONTO.test(konto) ? { konto } : 'konto: sAMAccountName des Dienstkontos (Buchstabe, dann Buchstaben/Ziffern/-, 3–20 Zeichen), z. B. svc-sqllnx';
}

export const COMPUTERKONTO_BESCHREIBUNG = 'Alfred I8e Computerkonto (Einmal-Kennwort)';
/** Tresor-Name des Einmal-Kennworts für den Domänenbeitritt (linux_sql ad_beitreten liest und verbraucht ihn) */
export const joinTresorName = (name: string) => `ad-join-${name.toLowerCase()}`;

export function pruefeComputerkonto(o: Record<string, unknown>): { name: string; ou: string } | string {
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const ou = o.ou === undefined ? 'Server' : typeof o.ou === 'string' ? o.ou.trim() : '';
  if (!COMPUTERNAME.test(name)) return 'name: Rechnername ohne $ (Buchstabe, dann Buchstaben/Ziffern/-, höchstens 15 Zeichen), z. B. sqllnx01';
  if (!OU_NAME.test(ou)) return 'ou: OU direkt unter der Domäne (Standard Server)';
  return { name: name.toUpperCase(), ou };
}

/** PTR: Zone muss die IP enthalten; name = der Teil der IP unterhalb der Zone (bei /24-Zone das letzte Oktett) */
export function pruefePtr(o: Record<string, unknown>): { zone: string; ip: string; fqdn: string; name: string } | string {
  const zone = String(o.zone ?? '').trim().toLowerCase().replace(/\.$/, '');
  const ip = String(o.ip ?? '').trim();
  const fqdn = String(o.fqdn ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!REVERSE_ZONE.test(zone)) return 'zone: Reverse-Zone, z. B. 30.203.10.in-addr.arpa';
  if (!IPV4.test(ip)) return 'ip: IPv4-Adresse';
  if (!AD_DOMAENE.test(fqdn)) return 'fqdn: vollständiger DNS-Name in Kleinbuchstaben, z. B. sqllnx01.ad.3033.at';
  const netz = zone.replace(/\.in-addr\.arpa$/, '').split('.').reverse();
  const teile = ip.split('.');
  if (netz.some((x, i) => String(Number(x)) !== String(Number(teile[i])))) return `ip: ${ip} liegt nicht in der Zone ${zone}`;
  return { zone, ip, fqdn, name: teile.slice(netz.length).reverse().join('.') };
}

export const GRUPPE_BESCHREIBUNG = 'Alfred I8e Gruppe';
export function pruefeGruppe(o: Record<string, unknown>): { gruppe: string; ou: string; mitglieder: string[] } | string {
  const gruppe = typeof o.gruppe === 'string' ? o.gruppe.trim() : '';
  const ou = o.ou === undefined ? 'Dienstkonten' : typeof o.ou === 'string' ? o.ou.trim() : '';
  const m = o.mitglieder === undefined ? [] : Array.isArray(o.mitglieder) ? o.mitglieder.map(x => String(x).trim()).filter(Boolean) : null;
  if (!GRUPPE.test(gruppe)) return 'gruppe: Gruppenname (Buchstabe, dann Buchstaben/Ziffern/. _ -, 2–64 Zeichen), z. B. SQL-Linux-Admins';
  if (!OU_NAME.test(ou)) return 'ou: OU direkt unter der Domäne (Standard Dienstkonten)';
  if (!m || m.length > 50 || m.some(x => !MITGLIED.test(x))) return 'mitglieder: Liste von sAMAccountNames (Benutzer, Computer mit $), höchstens 50';
  return { gruppe, ou, mitglieder: [...new Set(m)] };
}

export function pruefeSqlServer(s: unknown): string | { server: string } {
  const server = String(s ?? '').trim().toLowerCase();
  return SQL_SERVER.test(server) ? { server } : 'server: Name der SQL-Instanz in ad.3033.at (ohne Port), z. B. sqllnx01.ad.3033.at';
}

// ── SPNs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Träger eines SPN im ganzen Wald: globaler Katalog (Port 3268) dieses DCs — gleiche Datenbank, kein Replikationsverzug */
const SPN_TRAEGER = [
  "$gc = $dc + ':3268'",
  "function Traeger([string]$s) { @(Get-ADObject -LDAPFilter ('(servicePrincipalName=' + $s + ')') -Server $gc -Credential $c | ForEach-Object { [string]$_.DistinguishedName }) }",
];
const kontoLesen = "$u = Get-ADUser -Filter (\"SamAccountName -eq '\" + $p.konto + \"'\") -Properties servicePrincipalName -Server $dc -Credential $c";

/**
 * SPNs am Konto setzen (wie setspn -S): zuerst für alle SPNs prüfen, dass kein anderes Objekt im Wald sie trägt (sonst Abbruch, nichts
 * geändert), dann fehlende ergänzen. Wiederholbar. Selbstprüfung: jeder SPN genau einmal im Wald, und zwar an diesem Konto.
 * Eingabe { kennwort } (Domänen-Administrator).
 */
export function spnSetzenSkript(p: { konto: string; spns: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    ...SPN_TRAEGER,
    kontoLesen,
    "if (-not $u) { throw ('Konto ' + $p.konto + ' fehlt (windows_ad dienstkonto_anlegen)') }",
    "foreach ($s in @($p.spns)) { $fremd = @(Traeger $s | Where-Object { $_ -ne $u.DistinguishedName }); if ($fremd.Count) { throw ('SPN ' + $s + ' gehört schon ' + ($fremd -join ', ') + ' - nichts geändert') } }",
    "$neu = @(); foreach ($s in @($p.spns)) { if (@($u.servicePrincipalName) -notcontains $s) { Set-ADUser -Identity $u -ServicePrincipalNames @{ Add = $s } -Server $dc -Credential $c; $neu += $s } }",
    "$u = Get-ADUser -Identity $u.DistinguishedName -Properties servicePrincipalName -Server $dc -Credential $c",
    "$l = @(foreach ($s in @($p.spns)) { $t = @(Traeger $s); [ordered]@{ spn = $s; traeger = $t.Count; amKonto = ((@($u.servicePrincipalName) -contains $s) -and $t.Count -eq 1 -and $t[0] -eq $u.DistinguishedName) } })",
    "Ergebnis ([ordered]@{ konto = $p.konto; dn = [string]$u.DistinguishedName; neu = @($neu); spns = $l })",
  ].join('\n');
}

/** Rückweg: nur die genannten SPNs von genau diesem Konto entfernen; Selbstprüfung: keiner davon mehr am Konto */
export function spnEntfernenSkript(p: { konto: string; spns: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    kontoLesen,
    "if (-not $u) { Ergebnis ([ordered]@{ konto = $p.konto; zustand = 'Konto nicht vorhanden'; entfernt = @() }); exit 0 }",
    // gespeicherten Wert entfernen (Schreibweise wie im AD)
    "$weg = @(); foreach ($s in @($p.spns)) { $ist = @(@($u.servicePrincipalName) | Where-Object { $_ -eq $s }); if ($ist.Count) { Set-ADUser -Identity $u -ServicePrincipalNames @{ Remove = [string]$ist[0] } -Server $dc -Credential $c; $weg += $s } }",
    "$u = Get-ADUser -Identity $u.DistinguishedName -Properties servicePrincipalName -Server $dc -Credential $c",
    "$rest = @(@($p.spns) | Where-Object { @($u.servicePrincipalName) -contains $_ })",
    "if ($rest.Count) { throw ('SPN nach dem Entfernen noch am Konto: ' + ($rest -join ', ')) }",
    "Ergebnis ([ordered]@{ konto = $p.konto; zustand = $(if ($weg.Count) { 'entfernt' } else { 'schon weg' }); entfernt = @($weg) })",
  ].join('\n');
}

/** Lesend: Träger jedes SPN im Wald (wie setspn -Q). Eingabe { kennwort } (Domänen-Administrator, Lesen mit vollem Token) */
export function spnLesenSkript(p: { spns: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    ...SPN_TRAEGER,
    "$l = @(foreach ($s in @($p.spns)) { [ordered]@{ spn = $s; traeger = @(Traeger $s) } })",
    'Ergebnis ([ordered]@{ spns = $l })',
  ].join('\n');
}

export interface SpnLesen { spns: Array<{ spn: string; traeger: string[] }> }
/** Fester Wortlaut: SPN_EINDEUTIG nur, wenn jeder SPN genau ein Objekt im Wald hat (und, mit konto, genau dieses) */
export function spnLesenText(r: SpnLesen, konto?: string): { eindeutig: boolean; text: string } {
  const amKonto = (dn: string) => !konto || dn.toLowerCase().startsWith(`cn=${konto.toLowerCase()},`);
  const z = (r.spns ?? []).map(x => {
    const t = x.traeger ?? [];
    const ok = t.length === 1 && amKonto(t[0]!);
    return { ok, text: `${x.spn}: ${t.length === 0 ? 'fehlt' : t.length === 1 ? `${ok ? 'genau einmal' : 'an einem anderen Konto'} (${t[0]})` : `MEHRFACH (${t.length}): ${t.join('; ')}`}` };
  });
  const eindeutig = z.length > 0 && z.every(x => x.ok);
  return { eindeutig, text: `${eindeutig ? 'SPN_EINDEUTIG' : 'SPN_PROBLEM'} — ${z.map(x => x.text).join(' | ')}` };
}

// ── Computerkonto mit Einmal-Kennwort ──────────────────────────────────────────────────────────────────────────────────────────────

/** Vermerk im Attribut info: pwdLastSet unmittelbar nach Alfreds Kennwortvergabe (ändert adcli das Kennwort, passt er nicht mehr) */
export const EINMAL_VERMERK = 'Alfred-Einmal-Kennwort pwdLastSet=';

/**
 * Computerkonto NAME$ in der OU vorbereiten (Linux-Beitritt per adcli --one-time-password). Fix-Runde 1: ein vorhandenes fremdes Konto
 * (Beschreibung nicht von Alfred) wird nie übernommen → Abbruch. Ein vorhandenes Alfred-Konto gilt als in Gebrauch (Abbruch, nichts
 * geändert), wenn es sich angemeldet hat, sein Kennwort seit Alfreds Vergabe geändert wurde (pwdLastSet ≠ Vermerk in info — adcli
 * setzt nach dem Beitritt ein eigenes) oder Beitritts-Attribute trägt (SPN host/ bzw. RestrictedKrbHost/, dNSHostName,
 * operatingSystem — Alfred selbst setzt keines davon). Sonst: neues Kennwort nur mit p.neu (neuer Tresor-Wert), sonst „schon“.
 * Kennwort { einmal } und Domänen-Administrator { kennwort } nur über die Standardeingabe.
 * Selbstprüfung: aktiv, OU, Vermerk = aktuelles pwdLastSet (bei neu gesetztem Kennwort zusätzlich aus diesem Lauf).
 */
export function computerkontoSkript(p: { name: string; ou: string; neu?: boolean; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$pfad = 'OU=' + $p.ou + ',' + $d.DistinguishedName",
    "if (-not (Get-ADOrganizationalUnit -Identity $pfad -Server $dc -Credential $c -ErrorAction SilentlyContinue)) { throw ('OU ' + $pfad + ' fehlt (windows_ad grundstruktur)') }",
    "$sam = $p.name + '$'",
    `$vp = ${psText(EINMAL_VERMERK)}`,
    '$start = [DateTime]::UtcNow.AddSeconds(-30)',
    '$pw = ConvertTo-SecureString $e.einmal -AsPlainText -Force',
    "$k = Get-ADComputer -Filter (\"SamAccountName -eq '\" + $sam + \"'\") -Properties Description, Enabled, lastLogonTimestamp, pwdLastSet, info, servicePrincipalName, dNSHostName, operatingSystem -Server $dc -Credential $c",
    '$gesetzt = $false',
    'if (-not $k) {',
    `  New-ADComputer -Name $p.name -SamAccountName $sam -Path $pfad -AccountPassword $pw -Enabled $true -Description ${psText(COMPUTERKONTO_BESCHREIBUNG)} -Server $dc -Credential $c`,
    "  $z = 'angelegt'; $gesetzt = $true",
    '} else {',
    `  if ($k.Description -ne ${psText(COMPUTERKONTO_BESCHREIBUNG)}) { throw ('Computerkonto ' + $sam + ' besteht schon (nicht von Alfred) - nichts geändert') }`,
    "  if (-not ([string]$k.DistinguishedName).EndsWith(',' + $pfad)) { throw ('Computerkonto ' + $sam + ' liegt nicht in ' + $pfad + ': ' + $k.DistinguishedName + ' - nichts geändert') }",
    '  $grund = @()',
    "  if ($k.lastLogonTimestamp) { $grund += ('angemeldet ' + [DateTime]::FromFileTimeUtc([int64]$k.lastLogonTimestamp).ToString('yyyy-MM-dd HH:mm') + ' UTC') }",
    "  if ([string]$k.info -ne ($vp + [string][int64]$k.pwdLastSet)) { $grund += 'Kennwort seit Alfreds Vergabe geändert' }",
    "  if (@(@($k.servicePrincipalName) | Where-Object { $_ -like 'host/*' -or $_ -like 'RestrictedKrbHost/*' }).Count) { $grund += 'SPN host/ gesetzt' }",
    "  if ($k.dNSHostName -or $k.operatingSystem) { $grund += 'dNSHostName/operatingSystem gesetzt' }",
    "  if ($grund.Count) { throw ('Computerkonto ' + $sam + ' ist in Gebrauch (' + ($grund -join ', ') + ') - nichts geändert') }",
    "  $z = 'schon'",
    "  if ($p.neu) { Set-ADAccountPassword -Identity $k -Reset -NewPassword $pw -Server $dc -Credential $c; $z = 'kennwort neu'; $gesetzt = $true }",
    "  if (-not $k.Enabled) { Enable-ADAccount -Identity $k -Server $dc -Credential $c; if ($z -eq 'schon') { $z = 'geaendert' } }",
    '}',
    "if ($gesetzt) { $n = Get-ADComputer -Identity $sam -Properties pwdLastSet -Server $dc -Credential $c; Set-ADComputer -Identity $n -Replace @{ info = ($vp + [string][int64]$n.pwdLastSet) } -Server $dc -Credential $c }",
    '$k = Get-ADComputer -Identity $sam -Properties Enabled, pwdLastSet, lastLogonTimestamp, info -Server $dc -Credential $c',
    "$vermerkOk = ([string]$k.info -eq ($vp + [string][int64]$k.pwdLastSet)) -and ((-not $gesetzt) -or ($k.pwdLastSet -and [DateTime]::FromFileTimeUtc([int64]$k.pwdLastSet) -ge $start))",
    "Ergebnis ([ordered]@{ zustand = $z; konto = ($d.NetBIOSName + '\\' + $sam); dn = [string]$k.DistinguishedName; aktiv = [bool]$k.Enabled; inOu = ([string]$k.DistinguishedName).EndsWith(',' + $pfad); kennwortGesetzt = [bool]$vermerkOk; ohneAnmeldung = (-not $k.lastLogonTimestamp) })",
  ].join('\n');
}

/** Rückweg: entfernt nur ein von Alfred angelegtes Computerkonto (Beschreibung); Selbstprüfung: weg */
export function computerkontoEntfernenSkript(p: { name: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$sam = $p.name + '$'",
    "$k = Get-ADComputer -Filter (\"SamAccountName -eq '\" + $sam + \"'\") -Properties Description -Server $dc -Credential $c",
    `if (-not $k) { $z = 'nicht vorhanden' } elseif ($k.Description -ne ${psText(COMPUTERKONTO_BESCHREIBUNG)}) { throw ('Computerkonto ' + $sam + ' ist nicht von Alfred angelegt - nichts geändert') } else { Remove-ADObject -Identity $k.DistinguishedName -Recursive -Confirm:$false -Server $dc -Credential $c; $z = 'entfernt' }`,
    "if (Get-ADComputer -Filter (\"SamAccountName -eq '\" + $sam + \"'\") -Server $dc -Credential $c) { throw ('Computerkonto ' + $sam + ' nach dem Entfernen noch vorhanden') }",
    'Ergebnis ([ordered]@{ konto = $sam; zustand = $z })',
  ].join('\n');
}

// ── Reverse-DNS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const dnsSitzung = '$cs = New-CimSession -ComputerName $dc -Credential $c';

/**
 * Reverse-Zone (AD-integriert, Replikation Wald) anlegen, falls sie fehlt, dann PTR. Wiederholbar; ein PTR auf einen anderen Namen →
 * Abbruch. Selbstprüfung: Resolve-DnsName -Type PTR an jedem DC der Domäne (neue Zonen lädt ein DNS-Server erst nach seinem AD-Abfrage-
 * Intervall — bis 10 min warten). Eingabe { kennwort }.
 */
export function dnsPtrSkript(p: { zone: string; name: string; ip: string; fqdn: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    dnsSitzung,
    "$r = [ordered]@{ zone = 'schon'; ptr = 'schon' }",
    'try {',
    '  $zz = Get-DnsServerZone -Name $p.zone -CimSession $cs -ErrorAction SilentlyContinue',
    "  if (-not $zz) { Add-DnsServerPrimaryZone -Name $p.zone -ReplicationScope Forest -DynamicUpdate Secure -CimSession $cs; $r.zone = 'angelegt' }",
    "  elseif (-not $zz.IsDsIntegrated) { throw ('Zone ' + $p.zone + ' ist nicht AD-integriert - nichts geändert') }",
    "  $da = @(Get-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType Ptr -CimSession $cs -ErrorAction SilentlyContinue | ForEach-Object { ([string]$_.RecordData.PtrDomainName).TrimEnd('.').ToLower() })",
    "  if ($da.Count) { if ($da.Count -gt 1 -or $da[0] -ne $p.fqdn) { throw ('PTR ' + $p.ip + ' zeigt schon auf ' + ($da -join ', ') + ' - nichts geändert') } }",
    "  else { Add-DnsServerResourceRecordPtr -ZoneName $p.zone -Name $p.name -PtrDomainName ($p.fqdn + '.') -CimSession $cs; $r.ptr = 'angelegt' }",
    '} finally { Remove-CimSession -CimSession $cs -ErrorAction SilentlyContinue }',
    "$dcs = @(Get-ADDomainController -Filter * -Server $dc -Credential $c | ForEach-Object { [ordered]@{ name = [string]$_.HostName; ip = [string]$_.IPv4Address; antwort = '' } })",
    '$bis = (Get-Date).AddSeconds(600)',
    'do {',
    '  $offen = @()',
    "  foreach ($x in $dcs) { $a = @(Resolve-DnsName -Name $p.ip -Type PTR -Server $x.ip -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'PTR' } | ForEach-Object { ([string]$_.NameHost).TrimEnd('.').ToLower() }); $x.antwort = ($a -join ','); if ($a -notcontains $p.fqdn) { $offen += $x.name } }",
    '  if ($offen.Count) { Start-Sleep -Seconds 15 }',
    '} while ($offen.Count -and (Get-Date) -lt $bis)',
    '$r.dcs = $dcs; $r.offen = @($offen)',
    'Ergebnis $r',
  ].join('\n');
}

/** Rückweg: nur PTR-Einträge der IP, die auf genau diesen Namen zeigen; die Zone bleibt. Selbstprüfung am DC: kein solcher PTR mehr */
export function dnsPtrLoeschenSkript(p: { zone: string; name: string; ip: string; fqdn: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    dnsSitzung,
    'try {',
    "  $z = 'schon weg'",
    "  foreach ($x in @(Get-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType Ptr -CimSession $cs -ErrorAction SilentlyContinue)) { if (([string]$x.RecordData.PtrDomainName).TrimEnd('.').ToLower() -eq $p.fqdn) { Remove-DnsServerResourceRecord -ZoneName $p.zone -InputObject $x -Force -CimSession $cs; $z = 'entfernt' } }",
    "  $rest = @(Get-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType Ptr -CimSession $cs -ErrorAction SilentlyContinue | Where-Object { ([string]$_.RecordData.PtrDomainName).TrimEnd('.').ToLower() -eq $p.fqdn })",
    "  if ($rest.Count) { throw ('PTR ' + $p.ip + ' -> ' + $p.fqdn + ' nach dem Löschen noch vorhanden') }",
    '} finally { Remove-CimSession -CimSession $cs -ErrorAction SilentlyContinue }',
    'Ergebnis ([ordered]@{ zustand = $z })',
  ].join('\n');
}

// ── Gruppe ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Globale Sicherheitsgruppe in der OU anlegen und fehlende Mitglieder ergänzen (vorhandene weitere Mitglieder bleiben, das Ergebnis
 * nennt sie). Eine fremde Gruppe gleichen Namens → Abbruch. Selbstprüfung: alle Mitglieder zurückgelesen. Eingabe { kennwort }.
 */
export function gruppeSkript(p: { gruppe: string; ou: string; mitglieder: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$pfad = 'OU=' + $p.ou + ',' + $d.DistinguishedName",
    "if (-not (Get-ADOrganizationalUnit -Identity $pfad -Server $dc -Credential $c -ErrorAction SilentlyContinue)) { throw ('OU ' + $pfad + ' fehlt (windows_ad grundstruktur)') }",
    "$g = Get-ADGroup -Filter (\"SamAccountName -eq '\" + $p.gruppe + \"'\") -Properties Description -Server $dc -Credential $c",
    `if (-not $g) { New-ADGroup -Name $p.gruppe -SamAccountName $p.gruppe -GroupScope Global -GroupCategory Security -Path $pfad -Description ${psText(GRUPPE_BESCHREIBUNG)} -Server $dc -Credential $c; $z = 'angelegt'; $g = Get-ADGroup -Identity $p.gruppe -Server $dc -Credential $c }`,
    `elseif ($g.Description -ne ${psText(GRUPPE_BESCHREIBUNG)}) { throw ('Gruppe ' + $p.gruppe + ' ist nicht von Alfred angelegt - nichts geändert') }`,
    "else { $z = 'schon' }",
    '$ist = @(Get-ADGroupMember -Identity $g -Server $dc -Credential $c | ForEach-Object { [string]$_.SamAccountName })',
    "$neu = @(); foreach ($m in @($p.mitglieder)) { if ($ist -notcontains $m) { Add-ADGroupMember -Identity $g -Members $m -Server $dc -Credential $c; $neu += $m } }",
    "if ($neu.Count -and $z -eq 'schon') { $z = 'geaendert' }",
    '$g = Get-ADGroup -Identity $g.DistinguishedName -Server $dc -Credential $c',
    '$ist = @(Get-ADGroupMember -Identity $g -Server $dc -Credential $c | ForEach-Object { [string]$_.SamAccountName })',
    "Ergebnis ([ordered]@{ zustand = $z; gruppe = ($d.NetBIOSName + '\\' + $p.gruppe); dn = [string]$g.DistinguishedName; inOu = ([string]$g.DistinguishedName).EndsWith(',' + $pfad); global = ([string]$g.GroupScope -eq 'Global'); mitglieder = $ist; neu = @($neu); fehlt = @(@($p.mitglieder) | Where-Object { $ist -notcontains $_ }) })",
  ].join('\n');
}

/** Rückweg: entfernt nur eine von Alfred angelegte Gruppe; Selbstprüfung: weg */
export function gruppeEntfernenSkript(p: { gruppe: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$g = Get-ADGroup -Filter (\"SamAccountName -eq '\" + $p.gruppe + \"'\") -Properties Description -Server $dc -Credential $c",
    `if (-not $g) { $z = 'nicht vorhanden' } elseif ($g.Description -ne ${psText(GRUPPE_BESCHREIBUNG)}) { throw ('Gruppe ' + $p.gruppe + ' ist nicht von Alfred angelegt - nichts geändert') } else { Remove-ADGroup -Identity $g -Confirm:$false -Server $dc -Credential $c; $z = 'entfernt' }`,
    "if (Get-ADGroup -Filter (\"SamAccountName -eq '\" + $p.gruppe + \"'\") -Server $dc -Credential $c) { throw ('Gruppe ' + $p.gruppe + ' nach dem Entfernen noch vorhanden') }",
    'Ergebnis ([ordered]@{ gruppe = $p.gruppe; zustand = $z })',
  ].join('\n');
}

// ── Anmeldeprobe von sql01 (Kerberos + Zertifikatsprüfung) ────────────────────────────────────────────────────────────────────────

/** Ruling R2: sqlcmd nur aus festen Pfaden (go-sqlcmd, ODBC-Werkzeuge 18 und 17) */
export const SQLCMD_PFADE = [
  'C:\\Program Files\\SqlCmd\\sqlcmd.exe',
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE',
  'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
];
export const SQL_PROBE_TSQL = 'SET NOCOUNT ON; SELECT auth_scheme, encrypt_option, @@SERVERNAME FROM sys.dm_exec_connections WHERE session_id = @@SPID';

/**
 * Geplante Aufgabe unter einem Domänenkonto (Kennwort-Anmeldung → Netz-Kerberos; das SSH-Token hat keines). Anders als MitKonto
 * (windows-cluster.ts, nur für Administratoren/SYSTEM) bekommt das Konto Ändern-Rechte auf einen eigenen Ordner je Lauf, damit es
 * Skript lesen und Ergebnis schreiben kann. Aufgabe und Ordner (mit Ergebnisdatei) werden immer entfernt.
 */
export const ALS_BENUTZER = [
  'function AlsBenutzer([string]$benutzer, [string]$kennwort, [string]$innen, [int]$sekunden) {',
  "  $id = 'Alfred-Probe-' + [guid]::NewGuid().ToString('N').Substring(0, 12)",
  "  $dir = Join-Path (Join-Path $env:ProgramData 'Alfred\\proben') $id",
  '  New-Item -ItemType Directory -Path $dir -Force | Out-Null',
  '  try {',
  '    $acl = New-Object System.Security.AccessControl.DirectorySecurity',
  '    $acl.SetAccessRuleProtection($true, $false)',
  "    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
  "    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($benutzer, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '    Set-Acl -Path $dir -AclObject $acl',
  "    $skript = Join-Path $dir 'probe.ps1'; $aus = Join-Path $dir 'ergebnis.json'",
  '    [IO.File]::WriteAllText($skript, $innen, (New-Object System.Text.UTF8Encoding $true))',
  "    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $skript + '\" \"' + $aus + '\"')",
  '    $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($sekunden + 60)) -MultipleInstances IgnoreNew',
  "    Register-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' -Action $a -Settings $s -User $benutzer -Password $kennwort -RunLevel Limited -Force | Out-Null",
  // Fix-Welle (Final-Review): kurz nach dem Start steht die Aufgabe noch auf Queued/Ready — fertig erst, wenn sie nicht mehr läuft UND
  // die Ergebnisdatei da ist oder LastRunTime nach dem Start liegt (sie also gelaufen ist); begrenzt durch $sekunden
  '    $start = (Get-Date).AddSeconds(-2)',
  "    Start-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\'",
  '    $bis = (Get-Date).AddSeconds($sekunden); $fertig = $false',
  '    do {',
  "      Start-Sleep -Seconds 3; $t = Get-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\'; $i = Get-ScheduledTaskInfo -TaskName $id -TaskPath '\\Alfred\\'",
  '      $gelaufen = (Test-Path $aus) -or ($i.LastRunTime -and [datetime]$i.LastRunTime -ge $start)',
  "      $fertig = $t.State -ne 'Running' -and $t.State -ne 'Queued' -and $gelaufen",
  '    } while (-not $fertig -and (Get-Date) -lt $bis)',
  "    if (-not $fertig) { if ($t.State -eq 'Running' -or $t.State -eq 'Queued') { Stop-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' }; throw ('Aufgabe nach ' + $sekunden + ' s abgebrochen (Zustand ' + $t.State + ', LastRunTime ' + $i.LastRunTime + ')') }",
  "    if (-not (Test-Path $aus)) { throw ('Aufgabe ohne Ergebnis (LastTaskResult ' + $i.LastTaskResult + ')') }",
  '    $o = [IO.File]::ReadAllText($aus) | ConvertFrom-Json',
  '    if ($o.fehler) { throw [string]$o.fehler }',
  '    return $o.wert',
  "  } finally { Unregister-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }",
  '}',
  "function DomaeneNetbios { $d = @(Get-CimInstance -ClassName Win32_NTDomain | Where-Object { $_.DnsForestName } | Select-Object -First 1); if (-not $d.Count -or -not $d[0].DomainName) { throw 'keiner Domäne beigetreten' }; [string]$d[0].DomainName }",
].join('\n');

/**
 * Anmeldeprobe auf einem Windows-Domänenmitglied (sql01): sqlcmd -E (Kerberos) -N (Verschlüsselung) ohne -C (Zertifikat wird geprüft)
 * unter dem Test-Konto. Eingabe { kennwort } (Kennwort des Test-Kontos). Ergebnis { sqlcmd, exit, ausgabe } — ausgewertet in TS.
 */
/**
 * Fix-Runde 1 — Argumente je Programm: go-sqlcmd (C:\Program Files\SqlCmd) nimmt -N mit Wert (s|m|o|true|…; ohne Wert schluckte es das
 * nächste Argument) → „-N m“ (Verschlüsselung Pflicht); ODBC-sqlcmd 17/18 kennt -N ohne Wert. Nie -C (Zertifikat wird geprüft).
 */
export function sqlcmdArgumente(pfad: string, server: string): string[] {
  const go = pfad.toLowerCase() === SQLCMD_PFADE[0]!.toLowerCase();
  return ['-S', server, '-E', ...(go ? ['-N', 'm'] : ['-N']), '-b', '-l', '15', '-h', '-1', '-W', '-s', '|', '-Q', SQL_PROBE_TSQL];
}

export function sqlAnmeldungSkript(p: { server: string; konto: string }): string {
  const aufrufe = SQLCMD_PFADE.map(pfad => ({ pfad, argumente: sqlcmdArgumente(pfad, p.server) }));
  const innen = innenSkript({ server: p.server, aufrufe }, [
    '$x = @(@($p.aufrufe) | Where-Object { Test-Path -LiteralPath $_.pfad } | Select-Object -First 1)',
    "if (-not $x.Count) { throw ('sqlcmd nicht gefunden (gesucht: ' + (@($p.aufrufe | ForEach-Object { $_.pfad }) -join '; ') + ') - zuerst die SQL-Befehlszeilenwerkzeuge auf diesem Rechner installieren') }",
    '$sa = @($x[0].argumente | ForEach-Object { [string]$_ })',
    // Windows PowerShell 5.1: Fehlerausgabe eines Programms wird mit Stop zur Ausnahme — hier soll sie in den Text
    "$ErrorActionPreference = 'Continue'",
    '$txt = & $x[0].pfad @sa 2>&1 | Out-String',
    '[ordered]@{ sqlcmd = [string]$x[0].pfad; exit = [int]$LASTEXITCODE; ausgabe = $txt.Trim() }',
  ]);
  return [
    ...kopf(p, true),
    ALS_BENUTZER,
    '$nb = DomaeneNetbios',
    `$w = AlsBenutzer ($nb + '\\' + $p.konto) $e.kennwort ${psText(innen)} 120`,
    'Ergebnis $w',
  ].join('\n');
}

export interface SqlAnmeldung { sqlcmd?: string; exit?: number; ausgabe?: string }
/** Marke SQL_KERBEROS_OK nur bei auth_scheme KERBEROS und encrypt_option TRUE */
export function sqlAnmeldungAuswerten(r: SqlAnmeldung, server: string): { ok: boolean; text: string; auth?: string; verschluesselt?: string; servername?: string } {
  const aus = String(r.ausgabe ?? '');
  const m = aus.split(/\r?\n/).map(z => z.trim()).map(z => /^([A-Za-z]+)\|(TRUE|FALSE)\|(\S+)$/i.exec(z)).find(Boolean);
  if (!m) return { ok: false, text: `${server}: Anmeldeprobe ohne Ergebniszeile (sqlcmd Exit ${r.exit ?? '?'}): ${aus.replace(/\s+/g, ' ').slice(-400) || 'keine Ausgabe'}` };
  const auth = m[1]!.toUpperCase(); const verschluesselt = m[2]!.toUpperCase(); const servername = m[3]!;
  const basis = { auth, verschluesselt, servername };
  const fehler = [auth !== 'KERBEROS' ? `NICHT KERBEROS (auth_scheme ${auth})` : '', verschluesselt !== 'TRUE' ? `NICHT VERSCHLÜSSELT (encrypt_option ${verschluesselt})` : ''].filter(Boolean);
  if (fehler.length) return { ok: false, text: `${server}: ${fehler.join(', ')} — @@SERVERNAME ${servername}`, ...basis };
  return { ok: true, text: `SQL_KERBEROS_OK ${server}: auth_scheme KERBEROS, encrypt_option TRUE, @@SERVERNAME ${servername}${r.sqlcmd ? ` (${r.sqlcmd})` : ''}`, ...basis };
}
