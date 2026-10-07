import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, createReadStream, type ReadStream } from 'node:fs';
import type { Logger } from 'pino';

/**
 * v1258 — Releases: der Server ist die Quelle für die Aktualisierung der Satelliten.
 *
 * Beim Start packt der Server sein eigenes installiertes Paket (`npm pack` im Paketordner) nach `data/releases/<Version>.tgz`,
 * berechnet SHA-256 und signiert die Prüfsumme mit einem Ed25519-Schlüssel, der beim ersten Start entsteht
 * (`data/release-key.json`, 0600). Der öffentliche Schlüssel geht mit dem Willkommen an die Geräte (beim ersten Kontakt
 * gemerkt), damit sie Tarballs auch außerhalb des VPN prüfen können. Die Geräte vergleichen Versionen, laden, prüfen
 * Prüfsumme und Signatur, installieren in ein eigenes Verzeichnis und starten sich über den wartenden Starter neu.
 */
export interface ReleaseInfo { version: string; datei: string; sha256: string; groesse: number; signatur: string; zeit: string }

/** Versionen wie 0.19.0-jarvis.1258 vergleichen: Zahlenfolgen numerisch, Rest lexikografisch. >0 wenn a neuer. */
export function vergleicheVersion(a: string, b: string): number {
  const za = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const zb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(za.length, zb.length); i++) {
    const x = za[i] ?? -1; const y = zb[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return a === b ? 0 : a > b ? 1 : -1;
}

export function sha256Datei(pfad: string): string {
  return createHash('sha256').update(readFileSync(pfad)).digest('hex');
}

export function signiere(sha256Hex: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(sha256Hex, 'utf8'), privateKeyPem).toString('base64');
}

export function pruefeSignatur(sha256Hex: string, signaturBase64: string, publicKeyPem: string): boolean {
  try { return verify(null, Buffer.from(sha256Hex, 'utf8'), publicKeyPem, Buffer.from(signaturBase64, 'base64')); } catch { return false; }
}

export class Releases {
  private readonly keyPfad: string;
  private publicKeyPem = '';
  private privateKeyPem = '';
  private aktuell?: ReleaseInfo;

  constructor(private readonly ordner: string, private readonly logger: Logger, private readonly dateiPfad?: string) {
    mkdirSync(ordner, { recursive: true });
    this.keyPfad = path.join(path.dirname(ordner), 'release-key.json');
    this.ladeOderErzeugeSchluessel();
    this.ladeAktuell();
  }

  get publicKey(): string { return this.publicKeyPem; }

  info(): ReleaseInfo | undefined { return this.aktuell; }

  pfadVon(version: string): string | undefined {
    const p = path.join(this.ordner, `${version}.tgz`);
    return existsSync(p) ? p : undefined;
  }

  stream(version: string): ReadStream | undefined {
    const p = this.pfadVon(version);
    return p ? createReadStream(p) : undefined;
  }

  /** Eigenes Paket als Tarball ablegen, falls für diese Version noch keiner liegt. */
  async sichereAktuell(version: string, paketOrdner: string): Promise<ReleaseInfo | undefined> {
    const ziel = path.join(this.ordner, `${version}.tgz`);
    if (!existsSync(ziel)) {
      if (!existsSync(path.join(paketOrdner, 'package.json'))) { this.logger.warn({ paketOrdner }, 'v1258 Releases: kein package.json im Paketordner'); return this.aktuell; }
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--silent', '--pack-destination', this.ordner], { cwd: paketOrdner, timeout: 120_000, windowsHide: true }, (err) => err ? reject(err) : resolve());
        });
        const erzeugt = readdirSync(this.ordner).filter(f => f.endsWith('.tgz') && f !== path.basename(ziel) && f.includes(version.replace(/[^0-9a-z.-]/gi, '')));
        const kandidat = erzeugt.find(f => f.startsWith('madh-io-alfred-ai')) ?? erzeugt[0];
        if (!kandidat) throw new Error('npm pack hat keinen Tarball erzeugt');
        renameSync(path.join(this.ordner, kandidat), ziel);
      } catch (err) { this.logger.warn({ err: (err as Error).message }, 'v1258 Releases: Tarball nicht erzeugt'); return this.aktuell; }
    }
    const sha256 = sha256Datei(ziel);
    const info: ReleaseInfo = { version, datei: path.basename(ziel), sha256, groesse: statSync(ziel).size, signatur: signiere(sha256, this.privateKeyPem), zeit: new Date().toISOString() };
    writeFileSync(path.join(this.ordner, 'aktuell.json'), JSON.stringify(info, null, 2));
    this.aktuell = info;
    this.logger.info({ version, groesse: info.groesse }, 'v1258 Release bereitgestellt');
    this.raeumeAuf(version);
    return info;
  }

  /** Ältere Tarballs löschen, die letzten drei bleiben. */
  private raeumeAuf(aktuelle: string): void {
    try {
      const alle = readdirSync(this.ordner).filter(f => f.endsWith('.tgz')).map(f => f.replace(/\.tgz$/, '')).sort(vergleicheVersion).reverse();
      for (const v of alle.slice(3)) if (v !== aktuelle) { try { renameSync(path.join(this.ordner, `${v}.tgz`), path.join(this.ordner, `${v}.tgz.alt`)); } catch { /* */ } }
    } catch { /* optional */ }
  }

  private ladeAktuell(): void {
    try { const i = JSON.parse(readFileSync(path.join(this.ordner, 'aktuell.json'), 'utf8')) as ReleaseInfo; if (i?.version && this.pfadVon(i.version)) this.aktuell = i; } catch { /* keins */ }
  }

  private ladeOderErzeugeSchluessel(): void {
    try {
      const k = JSON.parse(readFileSync(this.keyPfad, 'utf8')) as { publicKeyPem: string; privateKeyPem: string };
      if (k.publicKeyPem && k.privateKeyPem) { this.publicKeyPem = k.publicKeyPem; this.privateKeyPem = k.privateKeyPem; return; }
    } catch { /* neu erzeugen */ }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(this.keyPfad, JSON.stringify({ publicKeyPem: this.publicKeyPem, privateKeyPem: this.privateKeyPem }), { mode: 0o600 });
    this.logger.info({ pfad: this.keyPfad }, 'v1258 Release-Schlüssel erzeugt');
  }
}
