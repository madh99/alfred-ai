import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { vergleicheVersion, pruefeSignatur, NEUSTART_CODE, cliOrdner, ladeAktuell, speichereAktuell, bestaetigeAktuell, startbareVersion, markiereGescheitert, installiereTarball, type AktuellEintrag } from '@alfred/core';
import { geraetAnfrage, geraetJson } from './geraet-http.js';
import { ladeKonfig, speichereKonfig, type GeraetKonfig } from './pair.js';

/**
 * v1258 — Satelliten-Autoupdate vom Server.
 *
 * Ablage: ~/.alfred/cli/<Version>/ (npm install --prefix, ohne sudo, ohne das globale npm anzufassen) und
 * ~/.alfred/cli/aktuell.json {version, einstieg, zeit, bestaetigt}. Der global installierte `alfred` ist nur noch der
 * Starter: er führt die neueste bestätigte Version aus und wartet auf sie (Dienstüberwachung bleibt intakt).
 * Beendet sich der Satellit mit Code 75, hat er gerade aktualisiert — der Starter startet die neue Version.
 * Eine frisch installierte Version gilt zehn Minuten als „auf Probe"; meldet sie sich beim Server, wird sie bestätigt,
 * sonst fällt der Starter auf die vorige bestätigte Version zurück.
 */
// v1266 — Ablage, aktuell.json, Probe/Rückfall-Logik liegen jetzt in @alfred/core (geraete/aktualisierung.ts), gemeinsam mit dem Alfred-Selbstupdate
export { NEUSTART_CODE, cliOrdner, ladeAktuell, speichereAktuell, bestaetigeAktuell, startbareVersion };
export type { AktuellEintrag };

/**
 * Vom Starter aufgerufen: die laufende Version als Kindprozess ausführen und warten; bei Code 75 (aktualisiert) erneut
 * mit der dann neuesten. `immerKind` (Dienstmodus): auch die eigene Version läuft als Kind, damit der Starter nach einem
 * Update neu starten kann — unter Windows gibt es keinen Dienstwächter, der das übernähme (v1261).
 */
export function starteNeuesteVersion(eigene: string, args: string[], immerKind = false): number | undefined {
  let runden = 0;
  for (;;) {
    const z = startbareVersion(eigene);
    if (!z && !immerKind) return undefined; // selbst die neueste → normal weitermachen
    const einstieg = z?.einstieg ?? path.resolve(process.argv[1] ?? '');
    if (++runden > 20) return 1;
    const r = spawnSync(process.execPath, [einstieg, ...args], { stdio: 'inherit', env: { ...process.env, ALFRED_STARTER_VERSION: eigene } });
    if (r.status !== NEUSTART_CODE) {
      // v1266 — eine Version auf Probe ist abgestürzt: sofort als gescheitert merken und die vorige starten
      if (z && !z.bestaetigt && r.status !== 0 && markiereGescheitert(z.version)) { console.error(`[starter] ${z.version} beendet mit Code ${r.status ?? 'Signal'} — zurück auf die vorige Version`); continue; }
      return r.status ?? 1;
    }
  }
}

export interface UpdateInfo { version: string; sha256: string; groesse: number; signatur: string; datei: string }

/** Prüft beim Server und aktualisiert, wenn dort eine neuere Version liegt. Liefert die neue Version oder undefined. */
export async function aktualisiereWennNeuer(k: GeraetKonfig, eigene: string, log: (z: string) => void): Promise<string | undefined> {
  const tStart = Date.now();
  const info = await geraetJson<UpdateInfo>(k, 'GET', '/api/geraete/update');
  if (Date.now() - tStart > 5000) log(`Hinweis: Update-Abfrage dauerte ${Math.round((Date.now() - tStart) / 1000)} s`);
  if (!info?.version || vergleicheVersion(info.version, eigene) <= 0) return undefined;
  const a = ladeAktuell();
  if (a && a.version === info.version && existsSync(a.einstieg)) { log(`Update ${info.version} liegt schon bereit`); return info.version; }
  log(`Update verfügbar: ${eigene} → ${info.version} (${Math.round(info.groesse / 1024)} KB)`);
  const t0 = Date.now();
  const r = await geraetAnfrage(k, 'GET', '/api/geraete/update/datei', undefined, { timeoutMs: 300_000 });
  if (r.status !== 200) throw new Error(`Download HTTP ${r.status}`);
  const sha = createHash('sha256').update(r.data).digest('hex');
  if (sha !== info.sha256) throw new Error('Prüfsumme des Tarballs stimmt nicht');
  const schluessel = (k as GeraetKonfig & { releaseKey?: string }).releaseKey;
  if (schluessel) { if (!pruefeSignatur(info.sha256, info.signatur, schluessel)) throw new Error('Signatur des Releases ungültig'); }
  else log('Hinweis: kein Release-Schlüssel bekannt — Signatur nicht geprüft (wird beim nächsten Willkommen gemerkt)');
  mkdirSync(cliOrdner(), { recursive: true });
  const tgz = path.join(cliOrdner(), `${info.version}.tgz`);
  writeFileSync(tgz, r.data);
  log('Installiere …');
  const einstieg = await installiereTarball(tgz, info.version); // v1266 — gemeinsame Basis mit dem Selbstupdate
  try { unlinkSync(tgz); } catch { /* */ }
  speichereAktuell({ version: info.version, einstieg, zeit: new Date().toISOString(), bestaetigt: false, vorige: a?.bestaetigt ? a.version : undefined });
  log(`Installiert: ${info.version} in ${Math.round((Date.now() - t0) / 1000)} s → Neustart`);
  return info.version;
}

/** Release-Schlüssel aus dem Willkommen merken (beim ersten Kontakt; danach nur gleich). */
export function merkeReleaseKey(pem: unknown): 'gemerkt' | 'gleich' | 'abweichend' | 'leer' {
  if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) return 'leer';
  const k = ladeKonfig() as (GeraetKonfig & { releaseKey?: string }) | undefined;
  if (!k) return 'leer';
  if (!k.releaseKey) { k.releaseKey = pem; speichereKonfig(k); return 'gemerkt'; }
  return k.releaseKey === pem ? 'gleich' : 'abweichend';
}
