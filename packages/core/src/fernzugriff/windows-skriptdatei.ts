/**
 * v1823 — Owner-Entscheidung 12.11. (nach PKI-A a5b1175e Schritt 15/17/19): Windows-Bausteine laufen als Skriptdatei statt als
 * lange Befehlszeile `powershell -EncodedCommand <Base64>`. Defender wertet genau diese Aufrufform aus Fernsitzungen als
 * „ClickFix“ (MPLog „command line reported as threat“ auf pkiroot01 und fs01), auch mit ThreatID-Allow und ohne Ereignis.
 * Der Inhalt bleibt für Defender vollständig sichtbar: die Datei wird beim Schreiben geprüft, das Skript beim Ausführen (AMSI).
 * Microsofts eigene Verwaltungswerkzeuge (Intune, Configuration Manager) führen Skripte ebenso als Datei aus.
 * Später (PKI Stufe 3): Code-Signatur und AllSigned.
 *
 * Ablage: C:\Windows\Temp\alfred-s-<16 Hex>.ps1 — zufälliger Name (nicht vorab anlegbar), Windows\Temp lässt andere Benutzer
 * fremde Dateien weder lesen noch ändern; die Datei löscht sich als erste Zeile selbst (PowerShell hat sie dann schon geladen).
 * UTF-8 mit BOM, damit Windows PowerShell 5.1 Umlaute richtig liest. Keine -ExecutionPolicy-Umgehung: lokale Dateien ohne
 * Internet-Kennzeichen laufen unter der Standardrichtlinie RemoteSigned.
 */
const KODIERT = /^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/;

/** Skripttext aus einem bisherigen `powershell … -EncodedCommand`-Befehl; null, wenn der Befehl anders aussieht */
export function ausKodiertemBefehl(befehl: string): string | null {
  const m = KODIERT.exec(befehl.trim());
  return m ? Buffer.from(m[1]!, 'base64').toString('utf16le') : null;
}

export const SKRIPT_NAME = /^alfred-s-[0-9a-f]{16}\.ps1$/;
export const SELBST_LOESCHEN = "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue";

export interface SkriptDatei { name: string; pfadWindows: string; pfadSftp: string; inhalt: string; befehl: string; befehlArgumente: string[] }

export function skriptDatei(skript: string, zufallHex: string): SkriptDatei {
  if (!/^[0-9a-f]{16}$/.test(zufallHex)) throw new Error('Zufallsname: 16 Hex-Zeichen');
  const name = `alfred-s-${zufallHex}.ps1`;
  const pfadWindows = `C:\\Windows\\Temp\\${name}`;
  const befehlArgumente = ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', pfadWindows];
  return {
    name, pfadWindows, pfadSftp: `/C:/Windows/Temp/${name}`,
    // Zeilenenden bleiben, wie der Baustein sie erzeugt (Inhalte von Here-Strings/INF-Dateien \u00E4ndern sich nicht)
    inhalt: `\uFEFF${SELBST_LOESCHEN}\n${skript}\n`,
    befehl: `powershell -NoProfile -NonInteractive -File ${pfadWindows}`,
    befehlArgumente,
  };
}
