/**
 * Spec I8b (docs/specs/2026-11-01-windows-i8.md) — Bestandsaufnahme Windows, nur lesend.
 *
 * Feste PowerShell-Lesebefehle (alle auf der Windows-Leseliste des Fernzugriffs, Ausgabe als JSON), Parser ohne Modell. Ergebnis ist
 * derselbe Host-Bestand wie bei Linux (CMDB, Bericht, Standard-Changes) plus Windows-Angaben (Rollen, Updates, Domäne).
 */
import type { HostBestand } from './sammler.js';

export const WINDOWS_BEFEHLE = {
  os: 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json -Compress',
  system: 'Get-CimInstance Win32_ComputerSystem | Select-Object NumberOfLogicalProcessors, Domain, PartOfDomain | ConvertTo-Json -Compress',
  volumes: 'Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining | ConvertTo-Json -Compress',
  dienste: 'Get-Service | Select-Object Name, Status | ConvertTo-Json -Compress',
  ports: 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress',
  prozesse: 'Get-Process | Select-Object Id, ProcessName | ConvertTo-Json -Compress',
  rollen: 'Get-WindowsFeature | Select-Object Name, Installed | ConvertTo-Json -Compress',
  hotfixes: 'Get-HotFix | Select-Object HotFixID, InstalledOn | ConvertTo-Json -Compress',
  ausstehend: 'Start-WUScan | Select-Object Title | ConvertTo-Json -Compress',
} as const;

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
    .filter(v => zahl(v.Size) > 0 && (v.DriveLetter || v.FileSystemLabel))
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

export interface WindowsBestand { domaene?: string; rollen: string[]; hotfixes: { anzahl: number; letztes?: string }; ausstehend?: string[] }

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
  const a = await versuch('ausstehende Updates', WINDOWS_BEFEHLE.ausstehend, leseWinAusstehend);
  if (a) { b.updates = { anzahl: a.anzahl, sicherheit: a.sicherheit }; b.windows.ausstehend = a.titel; }
  return b;
}
