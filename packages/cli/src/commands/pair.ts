import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { getVersion } from '../version.js';
import { baueManifest, SATELLIT_STANDARD_VERZEICHNISSE } from './satellit.js';

/**
 * v1224 — `alfred pair --server https://host:3420 --code 12345678 [--name "PC"] [--insecure]`
 * Koppelt dieses Gerät mit dem Gehirn. Der Code kommt aus der Web-GUI (Kachel Geräte) bzw.
 * POST /api/geraete/pairing-code. Das Token landet in ~/.alfred/geraet.json (nur Owner lesbar).
 */
export interface GeraetKonfig {
  server: string;
  geraetId: string;
  token: string;
  name: string;
  insecure?: boolean;
  freigegebeneVerzeichnisse: string[];
  erlaubteProgramme: string[];
}

export function konfigPfad(): string { return path.join(os.homedir(), '.alfred', 'geraet.json'); }

export function ladeKonfig(): GeraetKonfig | undefined {
  const p = konfigPfad();
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, 'utf8')) as GeraetKonfig; } catch { return undefined; }
}

export function speichereKonfig(k: GeraetKonfig): void {
  const p = konfigPfad();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(k, null, 2), { mode: 0o600 });
}

export async function pairCommand(opts: { server?: string; code?: string; name?: string; insecure?: boolean; verzeichnisse?: string }): Promise<void> {
  if (!opts.server || !opts.code) {
    console.error('Nutzung: alfred pair --server https://host:3420 --code 12345678 [--name "Mein PC"] [--insecure] [--verzeichnisse "C:\\Users\\me\\Documents;D:\\Projekte"]');
    process.exit(1);
  }
  const server = opts.server.replace(/\/+$/, '');
  const name = opts.name ?? os.hostname();
  const freigegebene = (opts.verzeichnisse ? opts.verzeichnisse.split(/[;,]/).map(s => s.trim()).filter(Boolean) : SATELLIT_STANDARD_VERZEICHNISSE());
  const manifest = baueManifest(getVersion());
  const dispatcher = opts.insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  const res = await undiciFetch(`${server}/api/geraete/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: opts.code.trim(), name, manifest }),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const body = await res.json() as { ok?: boolean; id?: string; token?: string; name?: string; skillName?: string; grund?: string; error?: string };
  if (!res.ok || !body.ok || !body.id || !body.token) {
    console.error(`Pairing fehlgeschlagen: ${body.grund ?? body.error ?? res.status}`);
    process.exit(1);
  }
  speichereKonfig({ server, geraetId: body.id, token: body.token, name: body.name ?? name, insecure: !!opts.insecure, freigegebeneVerzeichnisse: freigegebene, erlaubteProgramme: [] });
  console.log(`Gekoppelt: ${body.name} → ${server} (Skill im Gehirn: ${body.skillName})`);
  console.log(`Konfiguration: ${konfigPfad()}`);
  console.log(`Freigegebene Verzeichnisse: ${freigegebene.join(', ')}`);
  console.log('Starte den Satelliten mit: alfred satellit');
}
