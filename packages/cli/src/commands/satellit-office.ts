import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * v1292 — Office über COM (Spec §18.3, Owner 08.10.: „office-com mit lesen"): klassisches Outlook und Excel auf einem
 * Windows-Gerät, auf dem Office installiert ist und der Benutzer angemeldet ist (Office-VM). Schnittstelle vor
 * Oberfläche: kein Klicken, sondern Outlook.Application / Excel.Application per PowerShell, Ergebnisse als JSON.
 * Lesen (Posteingang, Mail, Termine, Excel-Bereich) ist `auto`; alles, was speichert oder sendet, ist `bestaetigen`,
 * Senden ist ein eigener Schritt nach dem Entwurf. Ordner-IDs: 6 Posteingang, 9 Kalender, 16 Entwürfe, 5 Gesendet.
 */
export interface OfficeMail { id: string; datum: string; von: string; betreff: string; ungelesen: boolean; anhaenge: number; vorschau?: string }

function run(script: string, timeout = 60_000): Promise<string> {
  const enc = Buffer.from('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = "Stop"\n' + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout).trim();
      if (err) return reject(new Error(psFehlertext(String(stderr)) || err.message));
      resolve(letzteZeile(out));
    });
  });
}

/** PowerShell-Fehlerausgabe (oft CLIXML oder mehrzeilig) auf einen lesbaren Satz kürzen. */
export function psFehlertext(stderr: string): string {
  return stderr.replace(/^#< CLIXML\s*/, '').replace(/<[^>]+>/g, ' ').replace(/_x000D__x000A_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}
/** Die Skripte geben als letzte Zeile JSON aus; alles davor (Warnungen) wird ignoriert. */
export function letzteZeile(out: string): string {
  return out.split('\n').map(z => z.trim()).filter(Boolean).pop() ?? '{}';
}

const ps1 = (s: string) => s.replace(/'/g, "''");
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Gibt es das klassische Outlook MIT eingerichtetem Profil? Synchron beim Manifest-Bau, über die Registry:
 * COM-Klasse registriert UND ein Profil mit Konto unter HKCU (ohne Konto öffnet COM den Einrichtungsdialog — Realfall PC-madh).
 */
export function outlookVorhanden(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('reg', ['query', 'HKCR\\Outlook.Application'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
    // Ein Profil mit nur dem Adressbuch existiert auch ohne Einrichtung (PC-madh). Zähler der Mailkonten je Profil ist der
    // REG_BINARY-Wert {ED475418-…} im Kontenverwalter 9375CFF0…: leer = kein Mailkonto (PC), 02000000 = zwei (Office-VM, Exchange
    // ohne „Email"-Wert — v1292 erkannte darum nichts).
    const konten = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Office\\16.0\\Outlook\\Profiles', '/s', '/f', '{ED475418-B0D6-11D2-8C3B-00104B2A6676}', '/v', '/e'], { stdio: 'pipe', timeout: 10_000, windowsHide: true, encoding: 'utf8' });
    return konten.split(/\r?\n/).some(z => /\{ED475418-[0-9A-F-]+\}\s+REG_BINARY\s+[0-9A-Fa-f]{2,}/i.test(z));
  } catch { return false; }
}
export function excelVorhanden(): boolean {
  if (process.platform !== 'win32') return false;
  try { execFileSync('reg', ['query', 'HKCR\\Excel.Application'], { stdio: 'pipe', timeout: 5000, windowsHide: true }); return true; } catch { return false; }
}

const OUTLOOK_KOPF = `
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
function Iso($d) { if ($null -eq $d) { return $null } try { return ([datetime]$d).ToString('yyyy-MM-ddTHH:mm:ss') } catch { return $null } }
function Kurz($s, $n) { if ($null -eq $s) { return '' } $t = [string]$s; $t = $t -replace '\\s+', ' '; if ($t.Length -gt $n) { return $t.Substring(0, $n) } return $t }
`;

/** Posteingang (oder Ordner) auflisten: neueste zuerst, optional nur ungelesen, optional Suchtext in Betreff/Absender. */
export async function outlookPosteingang(o: { anzahl?: number; ungelesen?: boolean; suche?: string; ordner?: 'posteingang' | 'entwuerfe' | 'gesendet' } = {}): Promise<{ ordner: string; gesamt: number; ungelesen: number; mails: OfficeMail[] }> {
  const anzahl = Math.max(1, Math.min(o.anzahl ?? 15, 50));
  const ordnerId = o.ordner === 'entwuerfe' ? 16 : o.ordner === 'gesendet' ? 5 : 6;
  const script = `${OUTLOOK_KOPF}
$f = $ns.GetDefaultFolder(${ordnerId})
$items = $f.Items
$items.Sort('[ReceivedTime]', $true)
${o.ungelesen ? "$items = $items.Restrict('[Unread] = True')" : ''}
$suche = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.suche ?? '')}')).ToLower()
$out = New-Object System.Collections.ArrayList
$n = 0
foreach ($m in $items) {
  if ($m.Class -ne 43) { continue }
  if ($suche -and -not (([string]$m.Subject).ToLower().Contains($suche) -or ([string]$m.SenderName).ToLower().Contains($suche) -or ([string]$m.SenderEmailAddress).ToLower().Contains($suche))) { continue }
  $null = $out.Add(@{ id = $m.EntryID; datum = (Iso $m.ReceivedTime); von = (Kurz ("$($m.SenderName) <$($m.SenderEmailAddress)>") 120); betreff = (Kurz $m.Subject 160); ungelesen = [bool]$m.UnRead; anhaenge = $m.Attachments.Count; vorschau = (Kurz $m.Body 160) })
  $n++; if ($n -ge ${anzahl}) { break }
}
@{ ordner = $f.Name; gesamt = $f.Items.Count; ungelesen = $f.UnReadItemCount; mails = $out } | ConvertTo-Json -Compress -Depth 3
`;
  const j = JSON.parse(await run(script, 90_000)) as { ordner: string; gesamt: number; ungelesen: number; mails: OfficeMail[] | OfficeMail };
  return { ...j, mails: Array.isArray(j.mails) ? j.mails : j.mails ? [j.mails] : [] };
}

/** Eine Mail vollständig lesen (Text bis 6000 Zeichen, Anhänge mit Namen). */
export async function outlookMailLesen(id: string): Promise<{ id: string; datum: string; von: string; an: string; cc: string; betreff: string; text: string; gekuerzt: boolean; anhaenge: string[] }> {
  const script = `${OUTLOOK_KOPF}
$m = $ns.GetItemFromID('${ps1(id)}')
$body = [string]$m.Body
$ge = $body.Length -gt 6000
if ($ge) { $body = $body.Substring(0, 6000) }
$att = @(); foreach ($a in $m.Attachments) { $att += "$($a.FileName) ($([math]::Round($a.Size/1024)) KB)" }
@{ id = $m.EntryID; datum = (Iso $m.ReceivedTime); von = "$($m.SenderName) <$($m.SenderEmailAddress)>"; an = (Kurz $m.To 300); cc = (Kurz $m.CC 200); betreff = [string]$m.Subject; text = $body; gekuerzt = $ge; anhaenge = $att } | ConvertTo-Json -Compress -Depth 3
`;
  const j = JSON.parse(await run(script)) as { id: string; datum: string; von: string; an: string; cc: string; betreff: string; text: string; gekuerzt: boolean; anhaenge: string[] | string };
  return { ...j, anhaenge: Array.isArray(j.anhaenge) ? j.anhaenge : j.anhaenge ? [j.anhaenge] : [] };
}

/** Entwurf anlegen (nicht senden): gespeichert in Entwürfe und sichtbar geöffnet. Anhänge nur aus freigegebenen Pfaden (Aufrufer prüft). */
export async function outlookEntwurf(o: { an: string; betreff: string; text: string; cc?: string; anhaenge?: string[]; antwortAuf?: string }): Promise<{ id: string; betreff: string; an: string }> {
  const anh = (o.anhaenge ?? []).map(p => `$m.Attachments.Add('${ps1(p)}') | Out-Null`).join('\n');
  const script = `${OUTLOOK_KOPF}
${o.antwortAuf ? `$orig = $ns.GetItemFromID('${ps1(o.antwortAuf)}'); $m = $orig.Reply(); $m.Body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.text)}')) + "\`r\`n\`r\`n" + $m.Body` : `$m = $ol.CreateItem(0); $m.Body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.text)}'))`}
${o.an ? `$m.To = '${ps1(o.an)}'` : ''}
${o.cc ? `$m.CC = '${ps1(o.cc)}'` : ''}
${o.betreff && !o.antwortAuf ? `$m.Subject = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.betreff)}'))` : ''}
${anh}
$m.Save()
try { $m.Display() } catch {}
@{ id = $m.EntryID; betreff = [string]$m.Subject; an = [string]$m.To } | ConvertTo-Json -Compress
`;
  return JSON.parse(await run(script));
}

/** Einen Entwurf senden — eigener Schritt mit eigener Bestätigung. */
export async function outlookSenden(id: string): Promise<{ gesendet: boolean; betreff: string; an: string }> {
  const script = `${OUTLOOK_KOPF}
$m = $ns.GetItemFromID('${ps1(id)}')
if ($m.Sent) { @{ gesendet = $false; betreff = [string]$m.Subject; an = [string]$m.To; fehler = 'schon gesendet' } | ConvertTo-Json -Compress; exit 0 }
$betreff = [string]$m.Subject; $an = [string]$m.To
$m.Send()
@{ gesendet = $true; betreff = $betreff; an = $an } | ConvertTo-Json -Compress
`;
  return JSON.parse(await run(script));
}

/** Termine eines Zeitraums (Standard: heute bis in 7 Tagen), Serien aufgelöst. */
export async function outlookTermine(o: { von?: string; bis?: string; anzahl?: number } = {}): Promise<{ von: string; bis: string; termine: { id: string; start: string; ende: string; betreff: string; ort: string; ganztags: boolean; organisator: string }[] }> {
  const von = o.von ?? new Date().toISOString().slice(0, 10);
  const bis = o.bis ?? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const anzahl = Math.max(1, Math.min(o.anzahl ?? 40, 100));
  const script = `${OUTLOOK_KOPF}
$cal = $ns.GetDefaultFolder(9)
$items = $cal.Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$von = [datetime]'${ps1(von)}'; $bis = ([datetime]'${ps1(bis)}').AddDays(1)
$filter = "[Start] < '" + $bis.ToString('g') + "' AND [End] >= '" + $von.ToString('g') + "'"
$res = $items.Restrict($filter)
$out = New-Object System.Collections.ArrayList
$n = 0
foreach ($t in $res) {
  $null = $out.Add(@{ id = $t.EntryID; start = (Iso $t.Start); ende = (Iso $t.End); betreff = (Kurz $t.Subject 140); ort = (Kurz $t.Location 100); ganztags = [bool]$t.AllDayEvent; organisator = (Kurz $t.Organizer 80) })
  $n++; if ($n -ge ${anzahl}) { break }
}
@{ von = '${ps1(von)}'; bis = '${ps1(bis)}'; termine = $out } | ConvertTo-Json -Compress -Depth 3
`;
  const j = JSON.parse(await run(script, 90_000)) as { von: string; bis: string; termine: unknown };
  const t = j.termine;
  return { von: j.von, bis: j.bis, termine: Array.isArray(t) ? t as never : t ? [t as never] : [] };
}

/** Termin anlegen (gespeichert, nicht versendet; Teilnehmer nur eingetragen). */
export async function outlookTerminAnlegen(o: { betreff: string; start: string; ende: string; ort?: string; text?: string; teilnehmer?: string }): Promise<{ id: string; betreff: string; start: string; ende: string }> {
  const script = `${OUTLOOK_KOPF}
$t = $ol.CreateItem(1)
$t.Subject = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.betreff)}'))
$t.Start = [datetime]'${ps1(o.start)}'
$t.End = [datetime]'${ps1(o.ende)}'
${o.ort ? `$t.Location = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.ort)}'))` : ''}
${o.text ? `$t.Body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.text)}'))` : ''}
${o.teilnehmer ? `$t.MeetingStatus = 1; $t.RequiredAttendees = '${ps1(o.teilnehmer)}'` : ''}
$t.Save()
@{ id = $t.EntryID; betreff = [string]$t.Subject; start = (Iso $t.Start); ende = (Iso $t.End) } | ConvertTo-Json -Compress
`;
  return JSON.parse(await run(script));
}

/** Excel-Bereich lesen (ohne sichtbares Excel; Datei nur lesend geöffnet). */
export async function excelLesen(o: { datei: string; blatt?: string; bereich?: string }): Promise<{ datei: string; blatt: string; bereich: string; zeilen: string[][]; gekuerzt: boolean }> {
  if (!existsSync(o.datei)) throw new Error(`Datei nicht gefunden: ${o.datei}`);
  const script = `
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open('${ps1(o.datei)}', $false, $true)
  $ws = ${o.blatt ? `$wb.Worksheets.Item('${ps1(o.blatt)}')` : '$wb.Worksheets.Item(1)'}
  $r = ${o.bereich ? `$ws.Range('${ps1(o.bereich)}')` : '$ws.UsedRange'}
  $rows = [Math]::Min($r.Rows.Count, 200); $cols = [Math]::Min($r.Columns.Count, 30)
  $out = New-Object System.Collections.ArrayList
  for ($i = 1; $i -le $rows; $i++) { $zeile = @(); for ($j = 1; $j -le $cols; $j++) { $v = $r.Cells.Item($i, $j).Text; $zeile += [string]$v }; $null = $out.Add($zeile) }
  @{ datei = '${ps1(o.datei)}'; blatt = $ws.Name; bereich = $r.Address($false, $false); zeilen = $out; gekuerzt = ($r.Rows.Count -gt 200 -or $r.Columns.Count -gt 30) } | ConvertTo-Json -Compress -Depth 4
} finally { if ($wb) { $wb.Close($false) }; $xl.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null }
`;
  const j = JSON.parse(await run(script, 120_000)) as { datei: string; blatt: string; bereich: string; zeilen: unknown; gekuerzt: boolean };
  const z = j.zeilen;
  const zeilen = Array.isArray(z) ? (z as unknown[]).map(r => Array.isArray(r) ? (r as unknown[]).map(String) : [String(r)]) : [];
  return { ...j, zeilen };
}

/** Eine Zelle (oder einen Bereich mit Zeilen) schreiben und speichern. */
export async function excelSchreiben(o: { datei: string; blatt?: string; zelle: string; wert: string }): Promise<{ datei: string; blatt: string; zelle: string; wert: string }> {
  if (!existsSync(o.datei)) throw new Error(`Datei nicht gefunden: ${o.datei}`);
  const script = `
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open('${ps1(o.datei)}')
  $ws = ${o.blatt ? `$wb.Worksheets.Item('${ps1(o.blatt)}')` : '$wb.Worksheets.Item(1)'}
  $ws.Range('${ps1(o.zelle)}').Value2 = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.wert)}'))
  $wb.Save()
  @{ datei = '${ps1(o.datei)}'; blatt = $ws.Name; zelle = '${ps1(o.zelle)}'; wert = [string]$ws.Range('${ps1(o.zelle)}').Text } | ConvertTo-Json -Compress
} finally { if ($wb) { $wb.Close($true) }; $xl.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null }
`;
  return JSON.parse(await run(script, 120_000));
}
