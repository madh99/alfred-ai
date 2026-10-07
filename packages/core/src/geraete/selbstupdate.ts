import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { vergleicheVersion } from './releases.js';
import {
  PAKET_NAME, cliOrdner, ladeAktuell, speichereAktuell, bestaetigeAktuell, imPassFenster,
  pruefeTarball, installiereTarball, startprobe, raeumeVersionen, tarballInfo, npmBefehl, type AktuellEintrag,
} from './aktualisierung.js';

/**
 * v1266 — Alfred aktualisiert sich selbst (Punkt 2 der Aktualisierung, Owner-Freigabe 07.10.2026).
 *
 * Quelle: ein Tarball im Eingang (`data/updates/<Version>.tgz`, Begleitdatei `.sha256`) oder das npm-Register
 * (Paket mit Tag oder Version; npm prüft dabei die Integrität). Ablauf nach Owner-Bestätigung: Tarball prüfen
 * (Paketname, Version neuer, Prüfsumme) → installieren nach ~/.alfred/cli/<Version> → Startprobe (`--version`)
 * → aktuell.json (auf Probe) → warten, bis kein Pass-Fenster, kein Vorhaben und keine Hör-Sitzung läuft →
 * Neustart mit Code 75. Der Starter führt die neue Version aus; sie bestätigt sich nach zwei Minuten Lebenszeichen
 * und meldet das dem Owner. Stürzt sie ab, startet der Starter die vorige, und die meldet den Fehlschlag.
 */
export type UpdateQuelle = { art: 'datei'; pfad?: string; version?: string } | { art: 'registry'; tag?: string; version?: string };

export interface SelbstupdateDeps {
  eigeneVersion: string;
  eingangOrdner: string;
  logger: Logger;
  /** Laufende Arbeit, die ein Neustart stören würde */
  ruhe: () => { vorhaben: number; hoeren: number };
  /** Ein Satz an den Owner (best-effort) */
  melde: (text: string) => Promise<unknown>;
  /** Beendet den Prozess mit Code 75 (sauberer Stop über den Starter) */
  neustart: () => void;
  /** Testbar: Installationsordner, Installer, Probe, Zeitgeber */
  cliOrdner?: string;
  installiere?: (tgz: string, version: string, ordner: string) => Promise<string>;
  probe?: (einstieg: string, version: string) => Promise<void>;
  jetzt?: () => Date;
  warteMs?: number;
  /** Längstes Warten auf Ruhe, dann Neustart trotzdem (Standard 60 min) */
  maxWartenMs?: number;
  /** Lebenszeichen-Frist bis zur Bestätigung der frischen Version (Standard 2 min) */
  bestaetigungMs?: number;
}

export interface UpdateLauf { version: string; quelle: string; phase: 'pruefen' | 'installieren' | 'probe' | 'warten' | 'neustart' | 'fehler' | 'fertig'; seit: string; hinweis?: string }

export interface UpdateUebersicht {
  laufend: string;
  starter: boolean;
  installiert?: AktuellEintrag;
  eingang: { datei: string; version: string; neuer: boolean; sha256Datei: boolean }[];
  registry?: Record<string, string>;
  lauf?: UpdateLauf;
}

export class Selbstupdate {
  private lauf?: UpdateLauf;
  private readonly freigaben = new Map<string, { version: string; quelle: UpdateQuelle; bis: number }>();
  private readonly ordner: string;

  constructor(private readonly deps: SelbstupdateDeps) {
    this.ordner = deps.cliOrdner ?? cliOrdner();
  }

  status(): UpdateLauf | undefined { return this.lauf; }

  /** Tarballs im Eingang, neueste zuerst. */
  async eingang(): Promise<UpdateUebersicht['eingang']> {
    let dateien: string[] = [];
    try { dateien = readdirSync(this.deps.eingangOrdner).filter(f => f.endsWith('.tgz')); } catch { return []; }
    const out: UpdateUebersicht['eingang'] = [];
    for (const f of dateien) {
      const pfad = path.join(this.deps.eingangOrdner, f);
      try {
        const info = await tarballInfo(pfad);
        if (info.name !== PAKET_NAME) continue;
        out.push({ datei: f, version: info.version, neuer: vergleicheVersion(info.version, this.deps.eigeneVersion) > 0, sha256Datei: existsSync(`${pfad}.sha256`) });
      } catch (err) { this.deps.logger.warn({ datei: f, err: (err as Error).message }, 'v1266 Tarball im Eingang unlesbar'); }
    }
    return out.sort((a, b) => vergleicheVersion(b.version, a.version));
  }

  /** dist-tags aus dem npm-Register (best-effort, 20 s). */
  async registryTags(): Promise<Record<string, string> | undefined> {
    try {
      const out = await this.npm(['view', PAKET_NAME, 'dist-tags', '--json'], 20_000);
      const j = JSON.parse(out) as Record<string, string>;
      return j && typeof j === 'object' ? j : undefined;
    } catch (err) { this.deps.logger.warn({ err: (err as Error).message }, 'v1266 npm view fehlgeschlagen'); return undefined; }
  }

  async uebersicht(mitRegistry = false): Promise<UpdateUebersicht> {
    return {
      laufend: this.deps.eigeneVersion,
      starter: !!process.env.ALFRED_STARTER_VERSION,
      installiert: ladeAktuell(this.ordner),
      eingang: await this.eingang(),
      registry: mitRegistry ? await this.registryTags() : undefined,
      lauf: this.lauf,
    };
  }

  /** Bestimmt den Kandidaten einer Quelle (ohne etwas zu verändern). */
  async kandidat(quelle: UpdateQuelle): Promise<{ version: string; beschreibung: string; quelle: UpdateQuelle }> {
    if (quelle.art === 'datei') {
      const e = await this.eingang();
      const treffer = quelle.version ? e.find(x => x.version === quelle.version) : quelle.pfad ? e.find(x => x.datei === path.basename(quelle.pfad!)) : e.find(x => x.neuer);
      if (!treffer) throw new Error(quelle.version ? `Im Eingang liegt keine ${quelle.version}` : `Im Eingang liegt kein Tarball neuer als ${this.deps.eigeneVersion}`);
      if (!treffer.neuer) throw new Error(`${treffer.version} ist nicht neuer als ${this.deps.eigeneVersion}`);
      return { version: treffer.version, beschreibung: `Tarball ${treffer.datei}${treffer.sha256Datei ? ' mit Prüfsumme' : ' ohne Begleit-Prüfsumme'}`, quelle: { art: 'datei', pfad: treffer.datei, version: treffer.version } };
    }
    let version = quelle.version;
    if (!version) {
      const tags = await this.registryTags();
      const tag = quelle.tag ?? 'latest';
      version = tags?.[tag];
      if (!version) throw new Error(`npm-Tag „${tag}" nicht gefunden`);
    }
    if (vergleicheVersion(version, this.deps.eigeneVersion) <= 0) throw new Error(`${version} ist nicht neuer als ${this.deps.eigeneVersion}`);
    return { version, beschreibung: `npm-Register ${PAKET_NAME}@${version}${quelle.tag ? ` (Tag ${quelle.tag})` : ''}`, quelle: { art: 'registry', version, tag: quelle.tag } };
  }

  /** Einmal-Freigabe für den Owner-Button (60 min, an die Version gebunden). */
  erzeugeFreigabe(version: string, quelle: UpdateQuelle): string {
    const nonce = randomBytes(12).toString('hex');
    for (const [k, v] of this.freigaben) if (v.bis < Date.now()) this.freigaben.delete(k);
    this.freigaben.set(nonce, { version, quelle, bis: Date.now() + 60 * 60_000 });
    return nonce;
  }

  verbraucheFreigabe(nonce: unknown, version: string): UpdateQuelle | undefined {
    if (typeof nonce !== 'string') return undefined;
    const f = this.freigaben.get(nonce);
    if (!f || f.bis < Date.now() || f.version !== version) return undefined;
    this.freigaben.delete(nonce);
    return f.quelle;
  }

  /** Startet den Ablauf im Hintergrund; liefert sofort. */
  starte(quelle: UpdateQuelle, version: string): UpdateLauf {
    if (this.lauf && !['fehler', 'fertig'].includes(this.lauf.phase)) throw new Error(`Es läuft schon ein Update auf ${this.lauf.version} (${this.lauf.phase})`);
    const q = quelle.art === 'datei' ? `Eingang ${quelle.pfad ?? ''}`.trim() : `npm ${quelle.tag ?? version}`;
    this.lauf = { version, quelle: q, phase: 'pruefen', seit: new Date().toISOString() };
    void this.ablauf(quelle, version).catch(async err => {
      this.setze('fehler', (err as Error).message);
      this.deps.logger.error({ err: (err as Error).message, version }, 'v1266 Selbstupdate fehlgeschlagen');
      await this.deps.melde(`❌ Update auf ${version} abgebrochen: ${(err as Error).message}. Es läuft weiter ${this.deps.eigeneVersion}.`);
    });
    return this.lauf;
  }

  private setze(phase: UpdateLauf['phase'], hinweis?: string): void {
    if (this.lauf) { this.lauf.phase = phase; this.lauf.hinweis = hinweis; }
    this.deps.logger.info({ version: this.lauf?.version, phase, hinweis }, 'v1266 Selbstupdate');
  }

  private async ablauf(quelle: UpdateQuelle, version: string): Promise<void> {
    const t0 = Date.now();
    let tgz: string;
    if (quelle.art === 'datei') {
      tgz = path.join(this.deps.eingangOrdner, quelle.pfad ?? `${version}.tgz`);
    } else {
      mkdirSync(this.deps.eingangOrdner, { recursive: true });
      await this.npm(['pack', `${PAKET_NAME}@${version}`, '--pack-destination', this.deps.eingangOrdner, '--silent'], 600_000);
      const kandidaten = readdirSync(this.deps.eingangOrdner).filter(f => f.endsWith(`${version}.tgz`));
      if (kandidaten.length !== 1) throw new Error(`npm pack lieferte ${kandidaten.length} Dateien für ${version}`);
      tgz = path.join(this.deps.eingangOrdner, kandidaten[0]!);
    }
    const p = await pruefeTarball(tgz, this.deps.eigeneVersion);
    if (p.version !== version) throw new Error(`Tarball trägt ${p.version}, erwartet ${version}`);
    this.setze('installieren', `${Math.round(statSync(tgz).size / 1024)} KB, sha256 ${p.sha256.slice(0, 12)}…`);
    const einstieg = await (this.deps.installiere ?? installiereTarball)(tgz, version, this.ordner);
    this.setze('probe');
    await (this.deps.probe ?? startprobe)(einstieg, version);
    const a = ladeAktuell(this.ordner);
    speichereAktuell({ version, einstieg, zeit: new Date().toISOString(), bestaetigt: false, vorige: a?.bestaetigt ? a.version : undefined }, this.ordner);
    const dauer = Math.round((Date.now() - t0) / 1000);
    this.setze('warten');
    await this.deps.melde(`⬆️ Update ${this.deps.eigeneVersion} → ${version} installiert und geprüft (${dauer} s). Neustart folgt außerhalb des Pass-Fensters, sobald kein Vorhaben und keine Hör-Sitzung läuft.`);
    const grund = await this.warteAufRuhe();
    // aktuell.json frisch stempeln: die Probe-Frist beginnt mit dem Neustart, nicht mit der Installation
    const b = ladeAktuell(this.ordner);
    if (b && b.version === version) speichereAktuell({ ...b, zeit: new Date().toISOString() }, this.ordner);
    this.setze('neustart', grund);
    await this.deps.melde(`🔄 Neustart auf ${version}${grund ? ` (${grund})` : ''}. Bestätigung nach zwei Minuten Lebenszeichen.`);
    this.deps.neustart();
  }

  /** Wartet auf einen ruhigen Moment; liefert einen Hinweis, wenn trotzdem gestartet wird. */
  private async warteAufRuhe(): Promise<string | undefined> {
    const start = Date.now();
    const max = this.deps.maxWartenMs ?? 60 * 60_000;
    const schritt = this.deps.warteMs ?? 15_000;
    for (;;) {
      const r = this.deps.ruhe();
      const fenster = imPassFenster((this.deps.jetzt ?? (() => new Date()))());
      if (!fenster && r.vorhaben === 0 && r.hoeren === 0) return undefined;
      if (Date.now() - start > max && !fenster) return `nach ${Math.round(max / 60_000)} min Warten trotz ${r.vorhaben} Vorhaben/${r.hoeren} Hör-Sitzung`;
      if (this.lauf) this.lauf.hinweis = fenster ? 'Pass-Fenster' : `${r.vorhaben} Vorhaben, ${r.hoeren} Hör-Sitzung`;
      await new Promise(res => setTimeout(res, schritt));
    }
  }

  /**
   * Beim Start der laufenden Version: frische Version bestätigt sich nach zwei Minuten Lebenszeichen; eine vorige
   * Version, die nach gescheiterter Probe wieder läuft, meldet den Fehlschlag und räumt den Eintrag.
   */
  nachStart(): void {
    const a = ladeAktuell(this.ordner);
    const eigene = this.deps.eigeneVersion;
    if (!a) return;
    if (a.version === eigene) {
      if (a.bestaetigt) return;
      setTimeout(() => {
        if (bestaetigeAktuell(eigene, this.ordner)) {
          const weg = raeumeVersionen([eigene, a.vorige ?? ''], this.ordner);
          this.deps.logger.info({ version: eigene, vorige: a.vorige, entfernt: weg }, 'v1266 Update bestätigt');
          void this.deps.melde(`✅ Update auf ${eigene} bestätigt — zwei Minuten Lebenszeichen${a.vorige ? `, Rückfall wäre ${a.vorige}` : ''}.`);
        }
      }, this.deps.bestaetigungMs ?? 2 * 60_000).unref?.();
      return;
    }
    // Eine andere Version steht im Eintrag: lief sie als Probe und ist gescheitert, sind wir der Rückfall
    if (!a.bestaetigt && vergleicheVersion(a.version, eigene) > 0) {
      const einstieg = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return process.argv[1] ?? ''; } })();
      speichereAktuell({ version: eigene, einstieg, zeit: new Date().toISOString(), bestaetigt: true }, this.ordner);
      raeumeVersionen([eigene], this.ordner);
      this.deps.logger.warn({ gescheitert: a.version, laeuft: eigene }, 'v1266 Update gescheitert — vorige Version läuft wieder');
      void this.deps.melde(`⚠️ Update auf ${a.version} ist gescheitert (Probe nicht bestätigt) — es läuft wieder ${eigene}.`);
    }
  }

  private npm(args: string[], timeout: number): Promise<string> {
    const npm = npmBefehl(); // v1285/v1287 — ohne PATH, über node + npm-cli.js
    return new Promise((resolve, reject) => {
      execFile(npm.cmd, [...npm.args, ...args], { timeout, windowsHide: true, shell: npm.shell, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` } }, (err, stdout, stderr) => err ? reject(new Error(`npm ${args[0]}: ${String(stderr).slice(0, 300) || err.message}`)) : resolve(String(stdout)));
    });
  }
}
