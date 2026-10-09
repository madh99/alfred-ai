import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { vergleicheVersion, pruefeSignatur, NEUSTART_CODE, cliOrdner, ladeAktuell, speichereAktuell, bestaetigeAktuell, startbareVersion, markiereGescheitert, installiereTarball, startprobe, type AktuellEintrag } from '@alfred/core'; // v1319 startprobe, rmSync
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

/** v1319 — Fehlversuche je Version (nur im Prozess): nach dem zweiten Fehlschlag 30 min Pause, nach dem fünften 6 h. */
const fehlversuche = new Map<string, { versuche: number; zuletzt: number }>();
export function merkeFehlversuch(version: string, jetzt = Date.now()): void {
  const f = fehlversuche.get(version);
  fehlversuche.set(version, { versuche: (f?.versuche ?? 0) + 1, zuletzt: jetzt });
}
export function darfErneutVersuchen(version: string, jetzt = Date.now()): { versuche: number; minuten: number } | undefined {
  const f = fehlversuche.get(version);
  if (!f || f.versuche < 2) return undefined;
  const pauseMin = f.versuche >= 5 ? 360 : 30;
  const rest = Math.ceil((f.zuletzt + pauseMin * 60_000 - jetzt) / 60_000);
  return rest > 0 ? { versuche: f.versuche, minuten: rest } : undefined;
}
/** Testbarkeit. */
export function vergissFehlversuche(): void { fehlversuche.clear(); }

/** Prüft beim Server und aktualisiert, wenn dort eine neuere Version liegt. Liefert die neue Version oder undefined. */
export async function aktualisiereWennNeuer(k: GeraetKonfig, eigene: string, log: (z: string) => void): Promise<string | undefined> {
  const tStart = Date.now();
  const info = await geraetJson<UpdateInfo>(k, 'GET', '/api/geraete/update');
  if (Date.now() - tStart > 5000) log(`Hinweis: Update-Abfrage dauerte ${Math.round((Date.now() - tStart) / 1000)} s`);
  if (!info?.version || vergleicheVersion(info.version, eigene) <= 0) return undefined;
  const a = ladeAktuell();
  // v1319 — Realfall PC 09.10.: npm hatte 1318 nur halb installiert (yoga-layout fehlte), die Startprobe des Starters
  // scheiterte, der Satellit meldete trotzdem „liegt schon bereit" und startete alle 20 s neu — bis er ganz stehen blieb.
  if (a && a.version === info.version && existsSync(a.einstieg) && !a.gescheitert) { log(`Update ${info.version} liegt schon bereit`); return info.version; }
  const sperre = darfErneutVersuchen(info.version);
  if (sperre) { log(`Update auf ${info.version} ist ${sperre.versuche}× gescheitert — nächster Versuch in ${sperre.minuten} min`); return undefined; }
  if (a && a.version === info.version && a.gescheitert) {
    log(`Version ${info.version} war auf Probe gescheitert — Ordner wird entfernt und neu installiert`);
    try { rmSync(path.join(cliOrdner(), info.version), { recursive: true, force: true }); } catch { /* Neuinstallation überschreibt */ }
  }
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
  let einstieg: string;
  try {
    einstieg = await installiereTarball(tgz, info.version); // v1266 — gemeinsame Basis mit dem Selbstupdate
    await startprobe(einstieg, info.version); // v1319 — unvollständige Installation fällt hier auf, nicht erst beim Starter
  } catch (err) {
    merkeFehlversuch(info.version);
    try { rmSync(path.join(cliOrdner(), info.version), { recursive: true, force: true }); } catch { /* */ }
    try { unlinkSync(tgz); } catch { /* */ }
    throw new Error(`Installation von ${info.version} unbrauchbar und wieder entfernt: ${(err as Error).message}`);
  }
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
