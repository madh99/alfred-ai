import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

/**
 * v1228 — Satellit als Dienst: startet mit der Anmeldung des Benutzers und läuft ohne Fenster.
 * Windows: Autostart-Ordner des Benutzers (ohne Adminrechte, im Benutzerkontext — nur so darf er Fenster öffnen),
 * macOS: launchd-Agent, Linux: systemd-Benutzerdienst. Der Dienst ruft genau das Programm auf,
 * aus dem `--install` lief (Node + Einstiegsdatei), also funktioniert es für npm-Installationen
 * und für den Monorepo-Build gleich. Protokoll in ~/.alfred/satellit.log.
 */
export const DIENST_NAME = 'Alfred Satellit';
const LAUNCHD_LABEL = 'at.alfred.satellit';
const SYSTEMD_UNIT = 'alfred-satellit.service';

export function dienstLogPfad(): string { return path.join(os.homedir(), '.alfred', 'satellit.log'); }

function programm(): { node: string; einstieg: string } {
  return { node: process.execPath, einstieg: path.resolve(process.argv[1] ?? '') };
}

/**
 * v1294 — Läuft dieser Prozess erhöht (Administrator, Integritätsstufe hoch/System)? Realfall Office-VM 08.10.: der Satellit
 * war aus einer Administrator-PowerShell gestartet; Outlook lief normal → COM-Anbindung scheiterte (80080005), UIA ebenso.
 */
export function laeuftErhoeht(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const g = execFileSync('whoami', ['/groups', '/fo', 'csv'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000, windowsHide: true });
    return /S-1-16-(12288|16384)/.test(g);
  } catch { return false; }
}

export function installiereDienst(): string {
  const { node, einstieg } = programm();
  mkdirSync(path.join(os.homedir(), '.alfred'), { recursive: true });
  if (process.platform === 'win32') {
    // Autostart-Ordner des Benutzers statt Aufgabenplanung: braucht keine Administratorrechte
    // (schtasks /SC ONLOGON verweigerte den Zugriff), läuft bei Anmeldung interaktiv im Benutzerkontext.
    // WScript.Shell.Run mit Fensterstil 0 startet Node ohne sichtbares Konsolenfenster (conhost --headless lief nicht an).
    const vbs = windowsStartSkript();
    const kommando = `""${node}"" ""${einstieg}"" satellit --dienst`;
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${kommando}", 0, False\r\n`);
    // v1264 — sofort über dasselbe VBS starten wie bei der Anmeldung (gleiche Umgebung): ein direkt abgelöster
    // Kindprozess des Installers hatte hängende HTTPS-Anfragen (Update-Prüfung), der VBS-Start nicht.
    // v1294 — aus einer erhöhten Shell würde der Satellit erhöht laufen (Office-COM/Bedienen scheitern): explorer.exe öffnet
    // das Skript in der normalen Benutzer-Shell mit mittlerer Integrität — so wie der Autostart bei der Anmeldung.
    const erhoeht = laeuftErhoeht();
    try { execFileSync(erhoeht ? 'explorer.exe' : 'wscript.exe', [vbs], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }); }
    catch { if (!erhoeht) starteWindowsJetzt(node, einstieg); }
    return `Autostart eingerichtet (${vbs}) und Satellit gestartet${erhoeht ? ' (ohne Administratorrechte, über die Benutzer-Shell)' : ''}. Protokoll: ${dienstLogPfad()}`;
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, `${LAUNCHD_LABEL}.plist`);
    // v1286 — eigene node-Kopie für den Satelliten: macOS vergibt Bedienungshilfen und Bildschirmaufnahme je Programmdatei.
    // Mit ~/.alfred/bin/alfred-node bekommt nur der Satellit die Rechte, nicht jedes node-Skript auf dem Mac (Owner-Frage 07.10.).
    const binDir = path.join(os.homedir(), '.alfred', 'bin');
    mkdirSync(binDir, { recursive: true });
    const alfredNode = path.join(binDir, 'alfred-node');
    let nodeFuerDienst = node;
    try { copyFileSync(node, alfredNode); chmodSync(alfredNode, 0o755); nodeFuerDienst = alfredNode; } catch { /* dann das normale node */ }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${nodeFuerDienst}</string><string>${einstieg}</string><string>satellit</string><string>--dienst</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${dienstLogPfad()}</string>
  <key>StandardErrorPath</key><string>${dienstLogPfad()}</string>
</dict></plist>
`;
    writeFileSync(plist, xml);
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'pipe' }); } catch { /* war nicht geladen */ }
    execFileSync('launchctl', ['load', plist], { stdio: 'pipe' });
    return `launchd-Agent ${LAUNCHD_LABEL} geladen (startet bei Anmeldung). Protokoll: ${dienstLogPfad()}`
      + (nodeFuerDienst === alfredNode ? `\nBerechtigungen für Bedienen und Bildschirmfoto: Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen bzw. Bildschirmaufnahme → „+" → Cmd+Shift+G → ${alfredNode}` : '');
  }
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const unit = path.join(dir, SYSTEMD_UNIT);
  writeFileSync(unit, `[Unit]
Description=Alfred Satellit (Gerätedienst)
After=network-online.target

[Service]
ExecStart=${node} ${einstieg} satellit --dienst
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { stdio: 'pipe' });
  return `systemd-Benutzerdienst ${SYSTEMD_UNIT} aktiviert und gestartet. Protokoll: ${dienstLogPfad()} bzw. journalctl --user -u ${SYSTEMD_UNIT}`;
}

function windowsStartSkript(): string {
  const dir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'Alfred Satellit.vbs');
}

function starteWindowsJetzt(node: string, einstieg: string): void {
  const c = spawn(node, [einstieg, 'satellit', '--dienst'], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
}

function windowsSatellitProzesse(): number {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*satellit --dienst*' -and $_.Name -like 'node*' } | Measure-Object).Count"], { encoding: 'utf8', windowsHide: true });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

export function entferneDienst(): string {
  if (process.platform === 'win32') {
    const vbs = windowsStartSkript();
    if (existsSync(vbs)) unlinkSync(vbs);
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*satellit --dienst*' -and $_.Name -like 'node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'pipe', windowsHide: true }); } catch { /* lief nicht */ }
    return 'Autostart entfernt und laufender Satellit beendet.';
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'pipe' }); } catch { /* */ }
    if (existsSync(plist)) unlinkSync(plist);
    return `launchd-Agent ${LAUNCHD_LABEL} entfernt.`;
  }
  try { execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { stdio: 'pipe' }); } catch { /* */ }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
  if (existsSync(unit)) unlinkSync(unit);
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' }); } catch { /* */ }
  return `systemd-Benutzerdienst ${SYSTEMD_UNIT} entfernt.`;
}

/** v1232 — läuft der Satellit bereits als Dienst? (Die Sitzung liest dann das Protokoll mit, statt ihn doppelt zu starten.) */
export function satellitDienstLaeuft(): boolean {
  try {
    if (process.platform === 'win32') return windowsSatellitProzesse() > 0;
    if (process.platform === 'darwin') return /"PID" = \d+/.test(execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' }));
    return execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { encoding: 'utf8' }).trim() === 'active';
  } catch { return false; }
}

export function dienstStatus(): string {
  try {
    if (process.platform === 'win32') { const n = windowsSatellitProzesse(); return `Autostart: ${existsSync(windowsStartSkript()) ? 'eingerichtet' : 'nicht eingerichtet'} · laufende Satellit-Prozesse: ${n}`; }
    if (process.platform === 'darwin') return execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
    return execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { encoding: 'utf8' }).trim();
  } catch (err) { return `nicht installiert (${(err as Error).message.split('\n')[0]})`; }
}
