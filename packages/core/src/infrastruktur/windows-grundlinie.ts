/**
 * Spec I8 (docs/specs/2026-11-01-windows-i8.md), Abschnitt 3b-2 — Standard-Vorlage (j) „Windows-Sicherheits-Grundlinie“ (Owner 07.11.:
 * „ja, so vorbereiten“): SMB-Signierung (Server und Client) erzwingen, TLS 1.0/1.1 (Server- und Client-Seite) abschalten.
 * SCHANNEL liest die Protokolle nur beim Start — deshalb immer ein Neustart, und der nur im Wartungsfenster.
 *
 * Bewusst NICHT in dieser Vorlage (Owner 07.11.): Windows LAPS (braucht das AD, kommt mit I8c) und „RDP nur aus Verwaltungszonen“
 * (Netz). Ablauf wie Vorlage (i): Snapshot → Vorher-Erhebung im Fenster → setzen → Neustart → Wiederanlauf → Nachher-Vergleich
 * und Prüfung über dieselben Lesebefehle wie die Bestandsaufnahme. Rückweg: Snapshot zurücksetzen.
 */
import { WINDOWS_BEFEHLE } from './sammler-windows.js';
import { SSH_LAEUFT, jetztWien, minus, ps, winNachherSkript, winUpdateOrdner, winVorherSkript } from './windows-updates.js';

const SCHANNEL = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols';

/** Grundlinie setzen; prüft das Fenster erneut (der Snapshot davor ist harmlos) */
export function winGrundlinieSkript(von: string, startBis: string): string {
  return ps([
    '$ErrorActionPreference = "Stop"',
    jetztWien,
    `if ($n -lt '${von}' -or $n -ge '${startBis}') { throw "ausserhalb des Fensters ${von}-${startBis}: $n" }`,
    'Set-SmbServerConfiguration -RequireSecuritySignature $true -EnableSecuritySignature $true -Force -Confirm:$false',
    'Set-SmbClientConfiguration -RequireSecuritySignature $true -EnableSecuritySignature $true -Force -Confirm:$false',
    // New-Item -Force auf einen VORHANDENEN Registry-Schlüssel legt ihn neu an und löscht seine Werte — nur anlegen, wenn er fehlt
    "foreach ($v in @('TLS 1.0', 'TLS 1.1')) { foreach ($r in @('Server', 'Client')) {",
    `  $p = '${SCHANNEL}\\' + $v + '\\' + $r`,
    '  if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }',
    "  New-ItemProperty -LiteralPath $p -Name 'Enabled' -Value 0 -PropertyType DWord -Force | Out-Null",
    "  New-ItemProperty -LiteralPath $p -Name 'DisabledByDefault' -Value 1 -PropertyType DWord -Force | Out-Null",
    '} }',
    "'GRUNDLINIE_GESETZT'",
  ]);
}

/** SCHANNEL braucht einen Neustart — immer, aber spätestens bis `rebootBis` */
export function winGrundlinieNeustartSkript(rebootBis: string): string {
  return ps([
    '$ErrorActionPreference = "Stop"',
    jetztWien,
    `if ($n -ge '${rebootBis}') { throw "zu spaet fuer einen Neustart: $n" }`,
    'shutdown.exe /r /t 60 /d p:2:4 /c "Alfred Standard-Change Sicherheits-Grundlinie"',
    "'GRUNDLINIE_NEUSTART in 60 s'",
  ]);
}

/** Ausgabe der Lesebefehle aus der Bestandsaufnahme, wenn die Grundlinie greift (ConvertTo-Json -Compress) */
export const GRUNDLINIE_ERWARTET = { signatur: '"RequireSecuritySignature":true', tls: '"Tls10":0,"Tls11":0' } as const;

/** Schritte der Vorlage (j) für eine Windows-VM */
export function winGrundlinieSchritte(z: string, vm: { vmid: number; node: string }, snap: string, fenster: { von: string; bis: string }): Array<Record<string, unknown>> {
  const d = winUpdateOrdner(`gl-${snap}`);
  const startBis = minus(fenster.bis, 45), rebootBis = minus(fenster.bis, 30);
  const rueck = { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } };
  const lies = (befehl: string, erwartet: string) => ({ typ: 'befehl', zugang: z, befehl, erwartet });
  return [
    { titel: `Snapshot ${snap}`, art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap, description: 'Alfred Standard-Change Sicherheits-Grundlinie, haltbar 7 Tage' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: snap }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } } },
    { titel: `Vorher: Fenster ${fenster.von}–${startBis} und laufende automatische Dienste festhalten`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winVorherSkript(d, fenster.von, startBis), timeout_s: 120 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck },
    { titel: 'Grundlinie setzen: SMB-Signierung erzwingen, TLS 1.0/1.1 abschalten', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winGrundlinieSkript(fenster.von, startBis), timeout_s: 120 }, pruefung: lies(WINDOWS_BEFEHLE.smbServer, GRUNDLINIE_ERWARTET.signatur), rueckweg: rueck },
    { titel: `Neustart für SCHANNEL (bis ${rebootBis})`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winGrundlinieNeustartSkript(rebootBis), timeout_s: 60 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck },
    { titel: 'Anlaufzeit', art: 'warten', sekunden: 180, zeitlimitS: 600 },
    { titel: 'VM läuft', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: 'running' }, zeitlimitS: 900 },
    // Realfall 06.11. (6f7b0b99): probe-win25b brauchte nach dem Start ~18 min bis zum Gast-Agenten
    { titel: 'Gast-Agent antwortet', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: vm.vmid, node: vm.node } }, zeitlimitS: 1800 },
    { titel: 'SSH wieder erreichbar', art: 'warten', pruefung: SSH_LAEUFT(z), zeitlimitS: 900 },
    { titel: 'Nachher: alle vorher laufenden Dienste laufen wieder', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winNachherSkript(d), timeout_s: 700 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck, zeitlimitS: 800 },
    { titel: 'Nachher: SMB-Signierung am Server erzwungen', art: 'pruefung', pruefung: lies(WINDOWS_BEFEHLE.smbServer, GRUNDLINIE_ERWARTET.signatur) },
    { titel: 'Nachher: SMB-Signierung am Client erzwungen', art: 'pruefung', pruefung: lies(WINDOWS_BEFEHLE.smbClient, GRUNDLINIE_ERWARTET.signatur) },
    { titel: 'Nachher: TLS 1.0/1.1 abgeschaltet', art: 'pruefung', pruefung: lies(WINDOWS_BEFEHLE.registry, GRUNDLINIE_ERWARTET.tls) },
  ];
}
