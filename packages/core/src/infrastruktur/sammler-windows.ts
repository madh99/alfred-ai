/**
 * Spec I8b (docs/specs/2026-11-01-windows-i8.md) — Bestandsaufnahme Windows, nur lesend.
 *
 * Feste PowerShell-Lesebefehle (alle auf der Windows-Leseliste des Fernzugriffs, Ausgabe als JSON), Parser ohne Modell. Ergebnis ist
 * derselbe Host-Bestand wie bei Linux (CMDB, Bericht, Standard-Changes) plus Windows-Angaben (Rollen, Updates, Domäne).
 */
import type { HostBestand } from './sammler.js';
import { WIN_GRUNDLINIE_REGISTRY, WIN_UEBERWACHUNG_DIENSTE, WIN_UEBERWACHUNG_EREIGNISSE, WIN_UEBERWACHUNG_ZERTIFIKATE, WIN_DC_GESUNDHEIT } from '../fernzugriff/regeln.js';

export const WINDOWS_BEFEHLE = {
  os: 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json -Compress',
  system: 'Get-CimInstance Win32_ComputerSystem | Select-Object NumberOfLogicalProcessors, Domain, PartOfDomain | ConvertTo-Json -Compress',
  volumes: 'Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining | ConvertTo-Json -Compress',
  dienste: 'Get-Service | Select-Object Name, Status | ConvertTo-Json -Compress',
  ports: 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress',
  prozesse: 'Get-Process | Select-Object Id, ProcessName | ConvertTo-Json -Compress',
  rollen: 'Get-WindowsFeature | Select-Object Name, Installed | ConvertTo-Json -Compress',
  hotfixes: 'Get-HotFix | Select-Object HotFixID, InstalledOn | ConvertTo-Json -Compress',
  // I8 3b-5 — Lizenz/Aktivierung: alle Lizenzprodukte (ohne Filter — ein -Filter bräuchte Anführungszeichen), ausgewertet wird im Parser
  lizenz: 'Get-CimInstance -ClassName SoftwareLicensingProduct | Select-Object Name, Description, ApplicationID, PartialProductKey, LicenseStatus, GracePeriodRemaining, EvaluationEndDate | ConvertTo-Json -Compress',
  // I8 3b-2a — Sicherheits-Grundlinie (Spec 3b-2), nur lesend
  smbServer: 'Get-SmbServerConfiguration | Select-Object EnableSMB1Protocol, RequireSecuritySignature, EncryptData | ConvertTo-Json -Compress',
  smbClient: 'Get-SmbClientConfiguration | Select-Object RequireSecuritySignature, EnableInsecureGuestLogons | ConvertTo-Json -Compress',
  firewall: 'Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction | ConvertTo-Json -Compress',
  defender: 'Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge, AntivirusSignatureLastUpdated | ConvertTo-Json -Compress',
  registry: WIN_GRUNDLINIE_REGISTRY,
  // I8 3b-3 — VSS-konsistente Sicherung: QEMU-Gast-Agent mit VSS-Provider und VSS-Dienst (nicht deaktiviert)
  vssProvider: 'Get-Service -Name QEMU* | Select-Object Name, Status, StartType | ConvertTo-Json -Compress',
  vssDienst: 'Get-Service -Name VSS | Select-Object Name, Status, StartType | ConvertTo-Json -Compress',
  // I8 3b-4 — Überwachung (auch stündlich, ohne den übrigen Bestand)
  dienstGestoppt: WIN_UEBERWACHUNG_DIENSTE,
  ereignisse: WIN_UEBERWACHUNG_EREIGNISSE,
  zertifikate: WIN_UEBERWACHUNG_ZERTIFIKATE,
  // I8c — Domänencontroller: dcdiag (nur Fehler) und Replikation; auf anderen Hosts {Dc:false}
  dcGesundheit: WIN_DC_GESUNDHEIT,
} as const;

/** I8 3b-4 — Überwachungsstand eines Windows-Hosts; fehlt ein Teil (Befehl gescheitert), bleibt das Feld leer (Erfassungslücke). */
export interface WindowsUeberwachung {
  /** Dienste mit Start „Automatisch“, die nicht laufen (ohne verzögerten/Auslöser-Start) */
  dienste?: Array<{ name: string; anzeige: string; zustand: string; exitCode: number }>;
  /** Kritische Ereignisse und Fehler der letzten 24 h je Quelle (höchstens 10 Quellen) */
  ereignisse?: Array<{ quelle: string; anzahl: number; kritisch: number; id: number; zuletzt?: string }>;
  zertifikate?: Array<{ betreff: string; fingerabdruck: string; ablauf?: string }>;
  /** I8c — nur auf Domänencontrollern: von dcdiag gemeldete fehlgeschlagene Tests, Replikationsverbindungen mit Fehlern */
  dc?: { dcdiagFehler: string[]; replikation: Array<{ quelle: string; kontext: string; fehler: number; letzterFehler?: string; status?: string }> };
}

/** I8c — dcdiag /q nennt nur Fehler („……… DC01 failed test DFSREvent“); repadmin /showrepl /csv je Verbindung eine showrepl_INFO-Zeile */
export function leseWinDcGesundheit(t: string): WindowsUeberwachung['dc'] | undefined {
  const j = JSON.parse(t.trim().replace(/^﻿/, '') || '{}') as { Dc?: boolean; Dcdiag?: string; Repl?: string };
  if (!j.Dc) return undefined;
  const dcdiagFehler = [...new Set([...String(j.Dcdiag ?? '').matchAll(/failed test (\S+)/gi)].map(m => m[1]!))];
  const zeilen = String(j.Repl ?? '').split(/\r?\n/).map(z => z.trim()).filter(Boolean);
  const kopf = zeilen.find(z => z.startsWith('showrepl_COLUMNS'))?.split(',') ?? [];
  const sp = (n: string) => kopf.findIndex(k => k.trim().toLowerCase() === n.toLowerCase());
  const iQ = sp('Source DSA'), iK = sp('Naming Context'), iF = sp('Number of Failures'), iZ = sp('Last Failure Time'), iS = sp('Last Failure Status');
  const replikation = zeilen.filter(z => z.startsWith('showrepl_INFO')).map(z => z.split(',')).map(f => ({
    quelle: f[iQ] ?? '?', kontext: f[iK] ?? '?', fehler: Number(f[iF] ?? 0) || 0,
    ...(f[iZ] && !/^0$/.test(f[iZ]!) ? { letzterFehler: f[iZ] } : {}), ...(f[iS] ? { status: f[iS] } : {}),
  }));
  return { dcdiagFehler, replikation };
}

export function leseWinDienstGestoppt(t: string): NonNullable<WindowsUeberwachung['dienste']> {
  return jsonListe<{ Name?: string; DisplayName?: string; State?: string; ExitCode?: number }>(t)
    .filter(d => d.Name).map(d => ({ name: String(d.Name), anzeige: String(d.DisplayName ?? d.Name), zustand: String(d.State ?? ''), exitCode: Number(d.ExitCode ?? 0) }));
}

export function leseWinEreignisse(t: string): NonNullable<WindowsUeberwachung['ereignisse']> {
  return jsonListe<{ Quelle?: string; Anzahl?: number; Kritisch?: number; Id?: number; Zuletzt?: unknown }>(t).filter(e => e.Quelle).map(e => {
    const z = cimDatum(e.Zuletzt);
    return { quelle: String(e.Quelle), anzahl: Number(e.Anzahl ?? 0), kritisch: Number(e.Kritisch ?? 0), id: Number(e.Id ?? 0), ...(z ? { zuletzt: new Date(z).toISOString() } : {}) };
  });
}

export function leseWinZertifikate(t: string): NonNullable<WindowsUeberwachung['zertifikate']> {
  return jsonListe<{ Subject?: string; Thumbprint?: string; NotAfter?: unknown }>(t).filter(z => z.Thumbprint).map(z => {
    const a = cimDatum(z.NotAfter);
    return { betreff: String(z.Subject ?? ''), fingerabdruck: String(z.Thumbprint), ...(a ? { ablauf: new Date(a).toISOString() } : {}) };
  });
}

/** I8 3b-4 — nur die Überwachung (stündlicher Lauf): Dateisysteme und die drei Überwachungsbefehle */
export async function sammleWindowsUeberwachung(lesen: (befehl: string) => Promise<string>, mitVolumes = true): Promise<{ dateisysteme?: HostBestand['dateisysteme']; ueberwachung: WindowsUeberwachung; fehler: string[] }> {
  const fehler: string[] = [];
  const versuch = async <T>(schluessel: string, befehl: string, f: (t: string) => T): Promise<T | undefined> => {
    try { return f(await lesen(befehl)); } catch (err) { fehler.push(`${schluessel}: ${(err as Error).message.slice(0, 160)}`); return undefined; }
  };
  const dateisysteme = mitVolumes ? await versuch('volumes', WINDOWS_BEFEHLE.volumes, leseWinVolumes) : undefined;
  const u: WindowsUeberwachung = {};
  const d = await versuch('dienste-gestoppt', WINDOWS_BEFEHLE.dienstGestoppt, leseWinDienstGestoppt); if (d) u.dienste = d;
  const e = await versuch('ereignisse', WINDOWS_BEFEHLE.ereignisse, leseWinEreignisse); if (e) u.ereignisse = e;
  const z = await versuch('zertifikate', WINDOWS_BEFEHLE.zertifikate, leseWinZertifikate); if (z) u.zertifikate = z;
  const dc = await versuch('dc', WINDOWS_BEFEHLE.dcGesundheit, leseWinDcGesundheit); if (dc) u.dc = dc;
  return { ...(dateisysteme ? { dateisysteme } : {}), ueberwachung: u, fehler };
}

/**
 * I8 3b-2a — Ist-Stand der Sicherheits-Grundlinie. Fehlt ein Teil (Befehl gescheitert), bleibt das Feld leer — das ist eine
 * Erfassungslücke, kein Befund.
 */
export interface WindowsGrundlinie {
  smb1?: boolean; smbSignaturServer?: boolean; smbSignaturClient?: boolean; gastAnmeldung?: boolean;
  firewall?: Array<{ profil: string; an: boolean; eingehend: 'blockieren' | 'zulassen' | 'standard' }>;
  defender?: { an: boolean; echtzeit: boolean; signaturTage?: number };
  rdp?: { an: boolean; nla: boolean };
  /** true = per Registry ausdrücklich abgeschaltet (Enabled=0); fehlt der Wert, gilt der Systemstandard */
  tls10Aus?: boolean; tls11Aus?: boolean;
  /** Windows LAPS: Sicherungsziel aus Richtlinie/CSP/lokaler Konfiguration (BackupDirectory 0 aus, 1 Entra, 2 AD) */
  laps?: 'ad' | 'entra' | 'aus';
  /** I8 3b-3 — VSS-Sicherung möglich: QEMU-VSS-Provider installiert und nicht deaktiviert; VSS-Dienst nicht deaktiviert */
  vss?: { provider: boolean; agent: boolean; dienst?: boolean };
}

const wahr = (x: unknown) => x === true || x === 1 || x === 'True' || x === 'true';
/** GpoBoolean von Get-NetFirewallProfile: 1/True an, 0/False aus, 2/NotConfigured = Standard (an) */
const fwAn = (x: unknown) => !(x === false || x === 0 || x === 'False');
/** Action von DefaultInboundAction: 2/Allow zulassen, 4/Block blockieren, 0/NotConfigured Standard (= blockieren) */
const fwEingehend = (x: unknown): 'blockieren' | 'zulassen' | 'standard' => (x === 2 || x === 'Allow' ? 'zulassen' : x === 4 || x === 'Block' ? 'blockieren' : 'standard');

export function leseWinSmbServer(t: string): Pick<WindowsGrundlinie, 'smb1' | 'smbSignaturServer'> {
  const s = jsonListe<{ EnableSMB1Protocol?: unknown; RequireSecuritySignature?: unknown }>(t)[0];
  return s ? { smb1: wahr(s.EnableSMB1Protocol), smbSignaturServer: wahr(s.RequireSecuritySignature) } : {};
}
export function leseWinSmbClient(t: string): Pick<WindowsGrundlinie, 'smbSignaturClient' | 'gastAnmeldung'> {
  const s = jsonListe<{ RequireSecuritySignature?: unknown; EnableInsecureGuestLogons?: unknown }>(t)[0];
  return s ? { smbSignaturClient: wahr(s.RequireSecuritySignature), gastAnmeldung: wahr(s.EnableInsecureGuestLogons) } : {};
}
export function leseWinFirewall(t: string): NonNullable<WindowsGrundlinie['firewall']> {
  return jsonListe<{ Name?: string; Enabled?: unknown; DefaultInboundAction?: unknown }>(t).filter(p => p.Name).map(p => ({ profil: String(p.Name), an: fwAn(p.Enabled), eingehend: fwEingehend(p.DefaultInboundAction) }));
}
export function leseWinDefender(t: string, jetzt = new Date()): WindowsGrundlinie['defender'] {
  const d = jsonListe<{ AMServiceEnabled?: unknown; AntivirusEnabled?: unknown; RealTimeProtectionEnabled?: unknown; AntivirusSignatureAge?: number; AntivirusSignatureLastUpdated?: unknown }>(t)[0];
  if (!d) return undefined;
  const alter = zahl(d.AntivirusSignatureAge), stand = cimDatum(d.AntivirusSignatureLastUpdated);
  // AntivirusSignatureAge ist 65535, wenn nie aktualisiert — dann zählt das Datum, sonst „unbekannt“
  const tage = Number.isFinite(alter) && alter < 65535 ? alter : stand !== undefined ? Math.floor((jetzt.getTime() - stand) / 86_400_000) : undefined;
  return { an: wahr(d.AMServiceEnabled) && wahr(d.AntivirusEnabled), echtzeit: wahr(d.RealTimeProtectionEnabled), ...(tage !== undefined ? { signaturTage: tage } : {}) };
}
/** StartType 4 = Disabled (Zahl oder Text) */
const deaktiviert = (x: unknown) => x === 4 || x === 'Disabled';
/** I8 3b-3 — QEMU-GA (Gast-Agent) und „QEMU Guest Agent VSS Provider“ */
export function leseWinVssProvider(t: string): { provider: boolean; agent: boolean } {
  const l = jsonListe<{ Name?: string; StartType?: unknown }>(t);
  const p = l.find(d => /VSS Provider/i.test(String(d.Name ?? ''))), g = l.find(d => /^QEMU-GA$/i.test(String(d.Name ?? '')));
  return { provider: !!p && !deaktiviert(p.StartType), agent: !!g && !deaktiviert(g.StartType) };
}
export function leseWinVssDienst(t: string): boolean | undefined {
  const d = jsonListe<{ Name?: string; StartType?: unknown }>(t)[0];
  return d ? !deaktiviert(d.StartType) : undefined;
}
export function leseWinRegistry(t: string): Pick<WindowsGrundlinie, 'rdp' | 'tls10Aus' | 'tls11Aus' | 'laps'> {
  const r = jsonListe<{ RdpAus?: number | null; Nla?: number | null; Tls10?: number | null; Tls11?: number | null; LapsCsp?: number | null; LapsGpo?: number | null; LapsLokal?: number | null }>(t)[0];
  if (!r) return {};
  // Vorrang wie bei Windows LAPS: CSP vor Gruppenrichtlinie vor lokaler Konfiguration
  const ziel = [r.LapsCsp, r.LapsGpo, r.LapsLokal].find(x => x !== null && x !== undefined);
  return {
    // fDenyTSConnections fehlt = Standard (RDP aus); UserAuthentication fehlt = Standard (NLA an)
    rdp: { an: r.RdpAus === 0, nla: r.Nla !== 0 },
    tls10Aus: r.Tls10 === 0, tls11Aus: r.Tls11 === 0,
    ...(ziel !== undefined && ziel !== null ? { laps: ziel === 2 ? 'ad' as const : ziel === 1 ? 'entra' as const : 'aus' as const } : {}),
  };
}

/** Anwendungs-ID von Windows in SoftwareLicensingProduct (die übrigen Einträge sind Office u. a.) */
export const WINDOWS_APP_ID = '55c92734-d682-4d71-983e-d6ec3f16059f';
export type LizenzStatus = 'aktiviert' | 'testversion' | 'kulanzfrist' | 'benachrichtigung' | 'nicht_aktiviert' | 'unbekannt';
export interface WindowsLizenz { status: LizenzStatus; kanal: string; produkt: string; ablauf?: string; restTage?: number }

/** CIM-Datum aus ConvertTo-Json: „/Date(ms)/“, ISO-Text oder Objekt mit DateTime; das Nulldatum 1601 heißt „keins“ */
function cimDatum(v: unknown): number | undefined {
  const s = typeof v === 'object' && v ? ((v as { value?: string; DateTime?: string }).value ?? (v as { DateTime?: string }).DateTime) : typeof v === 'string' ? v : undefined;
  const m = s ? /\/Date\((-?\d+)\)\//.exec(s) : null;
  const t = m ? Number(m[1]) : s ? Date.parse(s) : NaN;
  return Number.isFinite(t) && t > Date.UTC(1700, 0, 1) ? t : undefined;
}

/**
 * I8 3b-5 — Windows-Lizenz aus SoftwareLicensingProduct: das Windows-Produkt mit installiertem Schlüssel; Kanal aus der Beschreibung
 * (TIMEBASED_EVAL = Testversion, VOLUME_KMSCLIENT, VOLUME_MAK, RETAIL, OEM); Ablauf aus EvaluationEndDate bzw. der Restlaufzeit
 * (GracePeriodRemaining, Minuten). LicenseStatus: 0 nicht lizenziert, 1 lizenziert, 2–4/6 Kulanzfrist, 5 Benachrichtigung.
 */
export function leseWinLizenz(t: string, jetzt = new Date()): WindowsLizenz | undefined {
  const l = jsonListe<{ Name?: string; Description?: string; ApplicationID?: string; PartialProductKey?: string | null; LicenseStatus?: number; GracePeriodRemaining?: number; EvaluationEndDate?: unknown }>(t)
    .filter(p => String(p.ApplicationID ?? '').toLowerCase() === WINDOWS_APP_ID && p.PartialProductKey);
  const p = l.sort((a, b) => (zahl(b.LicenseStatus) === 1 ? 1 : 0) - (zahl(a.LicenseStatus) === 1 ? 1 : 0))[0];
  if (!p) return undefined;
  const d = String(p.Description ?? '');
  const eval_ = /TIMEBASED_EVAL|EVAL/i.test(`${d} ${p.Name ?? ''}`);
  const kanal = eval_ ? 'Testversion' : /VOLUME_KMSCLIENT/i.test(d) ? 'Volumen (KMS)' : /VOLUME_MAK/i.test(d) ? 'Volumen (MAK)' : /RETAIL/i.test(d) ? 'Einzelhandel' : /OEM/i.test(d) ? 'OEM' : 'unbekannt';
  const ls = zahl(p.LicenseStatus);
  const status: LizenzStatus = ls === 1 ? (eval_ ? 'testversion' : 'aktiviert') : ls === 0 ? 'nicht_aktiviert' : ls === 5 ? 'benachrichtigung' : [2, 3, 4, 6].includes(ls) ? 'kulanzfrist' : 'unbekannt';
  const rest = zahl(p.GracePeriodRemaining);
  const ende = cimDatum(p.EvaluationEndDate) ?? (Number.isFinite(rest) && rest > 0 ? jetzt.getTime() + rest * 60_000 : undefined);
  return { status, kanal, produkt: String(p.Name ?? 'Windows'), ...(ende !== undefined && (eval_ || status === 'kulanzfrist') ? { ablauf: new Date(ende).toISOString().slice(0, 10), restTage: Math.floor((ende - jetzt.getTime()) / 86_400_000) } : {}) };
}

/** ConvertTo-Json liefert bei einem Element ein Objekt, sonst ein Array; leer → [] */
export function jsonListe<T = Record<string, unknown>>(t: string): T[] {
  const s = t.trim().replace(/^﻿/, '');
  if (!s) return [];
  const x = JSON.parse(s) as T | T[];
  return Array.isArray(x) ? x : [x];
}

const zahl = (x: unknown) => (typeof x === 'number' ? x : Number(x));

export function leseWinOs(t: string): { os: HostBestand['os']; ram?: HostBestand['ram'] } {
  const o = jsonListe<{ Caption?: string; Version?: string; BuildNumber?: string; TotalVisibleMemorySize?: number; FreePhysicalMemory?: number }>(t)[0] ?? {};
  const gesamt = zahl(o.TotalVisibleMemorySize) * 1024, frei = zahl(o.FreePhysicalMemory) * 1024;
  return {
    os: { name: String(o.Caption ?? 'Windows').trim(), id: 'windows', ...(o.Version ? { version: `${o.Version}${o.BuildNumber ? ` (Build ${o.BuildNumber})` : ''}` } : {}) },
    ...(Number.isFinite(gesamt) && gesamt > 0 ? { ram: { gesamt, belegt: Number.isFinite(frei) ? gesamt - frei : gesamt } } : {}),
  };
}

export function leseWinSystem(t: string): { cpus?: number; domaene?: string } {
  const s = jsonListe<{ NumberOfLogicalProcessors?: number; Domain?: string; PartOfDomain?: boolean }>(t)[0] ?? {};
  return { ...(zahl(s.NumberOfLogicalProcessors) > 0 ? { cpus: zahl(s.NumberOfLogicalProcessors) } : {}), ...(s.PartOfDomain && s.Domain ? { domaene: s.Domain } : {}) };
}

const gib = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)}T` : b >= 1e9 ? `${(b / 1e9).toFixed(1)}G` : `${Math.round(b / 1e6)}M`);
export function leseWinVolumes(t: string): HostBestand['dateisysteme'] {
  return jsonListe<{ DriveLetter?: string | null; FileSystemLabel?: string; FileSystem?: string; Size?: number; SizeRemaining?: number }>(t)
    .filter(v => zahl(v.Size) > 0 && (v.DriveLetter || v.FileSystemLabel) && !/^(CDFS|UDF)$/i.test(String(v.FileSystem ?? '')))
    .map(v => {
      const g = zahl(v.Size), r = zahl(v.SizeRemaining);
      return { mount: v.DriveLetter ? `${v.DriveLetter}:` : String(v.FileSystemLabel), groesse: gib(g), belegt: gib(g - r), prozent: Math.round(((g - r) / g) * 100), ...(v.FileSystem ? { typ: v.FileSystem } : {}) };
    });
}

/** Laufende Dienste (Status 4 = Running bzw. „Running“) */
export function leseWinDienste(t: string): string[] {
  return jsonListe<{ Name?: string; Status?: number | string }>(t).filter(d => d.Status === 4 || d.Status === 'Running').map(d => String(d.Name)).filter(Boolean).sort();
}

export function leseWinPorts(t: string, prozesse: Map<number, string>): HostBestand['ports'] {
  const gesehen = new Set<string>();
  return jsonListe<{ LocalAddress?: string; LocalPort?: number; OwningProcess?: number }>(t)
    .filter(p => zahl(p.LocalPort) > 0)
    .map(p => ({ adresse: String(p.LocalAddress ?? ''), port: zahl(p.LocalPort), ...(prozesse.get(zahl(p.OwningProcess)) ? { prozess: prozesse.get(zahl(p.OwningProcess))! } : {}) }))
    .filter(p => { const k = `${p.adresse}:${p.port}`; if (gesehen.has(k)) return false; gesehen.add(k); return true; })
    .sort((a, b) => a.port - b.port);
}

export function leseWinProzesse(t: string): Map<number, string> {
  return new Map(jsonListe<{ Id?: number; ProcessName?: string }>(t).filter(p => p.ProcessName).map(p => [zahl(p.Id), String(p.ProcessName)]));
}

export function leseWinRollen(t: string): string[] {
  return jsonListe<{ Name?: string; Installed?: boolean }>(t).filter(r => r.Installed === true).map(r => String(r.Name)).sort();
}

/** Installierte Updates: Anzahl und letztes Installationsdatum (InstalledOn als „/Date(ms)/“ oder Objekt mit DateTime) */
export function leseWinHotfixes(t: string): { anzahl: number; letztes?: string } {
  const l = jsonListe<{ HotFixID?: string; InstalledOn?: unknown }>(t);
  const daten = l.map(h => {
    const v = h.InstalledOn as string | { value?: string; DateTime?: string } | null | undefined;
    const s = typeof v === 'object' && v ? (v.value ?? v.DateTime) : typeof v === 'string' ? v : undefined;
    const m = s ? /\/Date\((\d+)\)\//.exec(s) : null;
    if (m) return Number(m[1]);
    const d = s ? Date.parse(s) : NaN;
    return Number.isFinite(d) ? d : undefined;
  }).filter((x): x is number => x !== undefined);
  return { anzahl: l.length, ...(daten.length ? { letztes: new Date(Math.max(...daten)).toISOString().slice(0, 10) } : {}) };
}

/** Ausstehende Updates aus Start-WUScan; Sicherheit = kumulative bzw. Sicherheitsupdates (Titel) */
export function leseWinAusstehend(t: string): { anzahl: number; sicherheit: number; titel: string[] } {
  const titel = jsonListe<{ Title?: string }>(t).map(u => String(u.Title ?? '')).filter(Boolean);
  return { anzahl: titel.length, sicherheit: titel.filter(x => /security|sicherheit|cumulative|kumulativ/i.test(x)).length, titel: titel.slice(0, 20) };
}

export interface WindowsBestand { domaene?: string; rollen: string[]; hotfixes: { anzahl: number; letztes?: string }; ausstehend?: string[]; lizenz?: WindowsLizenz; grundlinie?: WindowsGrundlinie; ueberwachung?: WindowsUeberwachung }

/** Wie sammleLinux: jeder Befehl einzeln, Fehler je Teil im Bestand (z. B. Rollen gibt es auf Windows 11 nicht) */
export async function sammleWindows(zugang: string, host: string, lesen: (befehl: string) => Promise<string>): Promise<HostBestand & { windows: WindowsBestand }> {
  const b: HostBestand & { windows: WindowsBestand } = { zugang, host, dateisysteme: [], dienste: [], ports: [], container: [], compose: [], volumes: [], fehler: [], erfasst: new Date().toISOString(), windows: { rollen: [], hotfixes: { anzahl: 0 } } };
  const versuch = async <T>(schluessel: string, befehl: string, f: (t: string) => T): Promise<T | undefined> => {
    try { return f(await lesen(befehl)); } catch (err) { b.fehler.push(`${schluessel}: ${(err as Error).message.slice(0, 160)}`); return undefined; }
  };
  const os = await versuch('os', WINDOWS_BEFEHLE.os, leseWinOs);
  if (os) { b.os = os.os; if (os.ram) b.ram = os.ram; }
  const sys = await versuch('system', WINDOWS_BEFEHLE.system, leseWinSystem);
  if (sys?.cpus) b.cpus = sys.cpus;
  if (sys?.domaene) b.windows.domaene = sys.domaene;
  b.dateisysteme = (await versuch('volumes', WINDOWS_BEFEHLE.volumes, leseWinVolumes)) ?? [];
  b.dienste = (await versuch('dienste', WINDOWS_BEFEHLE.dienste, leseWinDienste)) ?? [];
  const prozesse = (await versuch('prozesse', WINDOWS_BEFEHLE.prozesse, leseWinProzesse)) ?? new Map<number, string>();
  b.ports = (await versuch('ports', WINDOWS_BEFEHLE.ports, t => leseWinPorts(t, prozesse))) ?? [];
  if (/server/i.test(b.os?.name ?? '')) b.windows.rollen = (await versuch('rollen', WINDOWS_BEFEHLE.rollen, leseWinRollen)) ?? [];
  b.windows.hotfixes = (await versuch('hotfixes', WINDOWS_BEFEHLE.hotfixes, leseWinHotfixes)) ?? { anzahl: 0 };
  const lizenz = await versuch('lizenz', WINDOWS_BEFEHLE.lizenz, t => leseWinLizenz(t));
  if (lizenz) b.windows.lizenz = lizenz;
  // I8 3b-2a — Sicherheits-Grundlinie; jeder Teil einzeln (Defender fehlt z. B. auf Servern ohne das Feature)
  const gl: WindowsGrundlinie = {
    ...(await versuch('smb', WINDOWS_BEFEHLE.smbServer, leseWinSmbServer)),
    ...(await versuch('smb-client', WINDOWS_BEFEHLE.smbClient, leseWinSmbClient)),
    ...(await versuch('registry', WINDOWS_BEFEHLE.registry, leseWinRegistry)),
  };
  const fw = await versuch('firewall', WINDOWS_BEFEHLE.firewall, leseWinFirewall);
  if (fw?.length) gl.firewall = fw;
  const def = await versuch('defender', WINDOWS_BEFEHLE.defender, t => leseWinDefender(t));
  if (def) gl.defender = def;
  // Get-Service -Name QEMU* ohne Treffer: leere Ausgabe mit Exit 0 → „kein Provider, kein Agent“ (kein Lesefehler)
  const vp = await versuch('vss', WINDOWS_BEFEHLE.vssProvider, leseWinVssProvider);
  if (vp) { const vd = await versuch('vss-dienst', WINDOWS_BEFEHLE.vssDienst, leseWinVssDienst); gl.vss = { ...vp, ...(vd !== undefined ? { dienst: vd } : {}) }; }
  if (Object.keys(gl).length) b.windows.grundlinie = gl;
  // I8 3b-4 — Überwachung auch im täglichen Bestand (Bericht und Problems wie der stündliche Lauf)
  const ue = await sammleWindowsUeberwachung(lesen, false);
  b.fehler.push(...ue.fehler);
  if (Object.keys(ue.ueberwachung).length) b.windows.ueberwachung = ue.ueberwachung;
  // ausstehende Updates: Start-WUScan gibt es auf Server 2025 nicht (Realfall probe-win25) — kommt mit den Windows-Updates (I8b Teil 3)
  return b;
}
