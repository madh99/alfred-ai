/**
 * Spec Infrastruktur-Vorhaben, I4c (Owner 22.10.2026, 5b-5 „Tresor: eigener am Server“) — Geheimnisse für Changes.
 *   - AES-256-GCM mit eigenem Schlüssel (data/tresor.key, 600; getrennt vom envEncryptionKey)
 *   - Werte nie ans Modell, nie in Logs; jeder Zugriff protokolliert (wer/wofür/wann, ohne Wert)
 *   - hinein nur über die Tresor-Seite im Web (direkt zum Server) oder als am Server erzeugtes Zufallspasswort
 *   - hinaus nur im Ausführungsmotor während eines freigegebenen Changes
 */
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const NAME = /^[a-z0-9][a-z0-9._-]{1,60}$/;
/** Felder, in denen {{geheim:…}} als ganzer Wert stehen darf (genau die Schlüssel, die die Skill-Sandbox im Log schwärzt — oberste Ebene, exakte Schreibweise) */
export const GEHEIM_FELDER = /^(password|secret|token|git_token|apiKey|api_key|accessToken|refreshToken|clientSecret)$/;

export interface TresorSpeicher {
  liste(o: string): Promise<Array<{ name: string; herkunft: string; zweck?: string; erstellt: string; geaendert: string }>>;
  roh(o: string, name: string): Promise<string | undefined>;
  setze(o: string, name: string, chiffre: string, herkunft: string, zweck?: string): Promise<void>;
  entferne(o: string, name: string): Promise<boolean>;
  protokolliere(o: string, name: string, art: string, wofuer?: string): Promise<void>;
}

export async function ladeSchluessel(pfad: string): Promise<Buffer> {
  try {
    const k = Buffer.from((await readFile(pfad, 'utf8')).trim(), 'base64');
    if (k.length === 32) return k;
    throw new Error('Tresor-Schlüssel hat nicht 32 Bytes');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const k = randomBytes(32);
    await mkdir(dirname(pfad), { recursive: true, mode: 0o700 });
    await writeFile(pfad, k.toString('base64'), { mode: 0o600, flag: 'wx' });
    await chmod(pfad, 0o600);
    return k;
  }
}

export function verschluessele(k: Buffer, wert: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(wert, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function entschluessele(k: Buffer, chiffre: string): string {
  const [v, iv, tag, ct] = chiffre.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Tresor-Eintrag unlesbar');
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Zufallspasswort ohne Zeichen, die in Shell/URL/YAML stören */
export function zufallsPasswort(laenge = 32): string {
  const z = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  return Array.from({ length: Math.min(128, Math.max(16, laenge)) }, () => z[randomInt(z.length)]).join('');
}

export class Tresor {
  private schluessel?: Buffer;
  constructor(private readonly d: { speicher: TresorSpeicher; schluesselPfad: string; protokoll?: (msg: string, daten: Record<string, unknown>) => void }) {}
  private async k(): Promise<Buffer> { return this.schluessel ??= await ladeSchluessel(this.d.schluesselPfad); }

  liste(o: string) { return this.d.speicher.liste(o); }
  async namen(o: string): Promise<Set<string>> { return new Set((await this.d.speicher.liste(o)).map(e => e.name)); }

  async setze(o: string, name: string, wert: string, herkunft: string, zweck?: string): Promise<void> {
    if (!NAME.test(name)) throw new Error('Name: Kleinbuchstaben, Ziffern, . _ - (2–61 Zeichen)');
    if (!wert || wert.length > 8192) throw new Error('Wert fehlt oder ist zu lang');
    await this.d.speicher.setze(o, name, verschluessele(await this.k(), wert), herkunft, zweck);
    await this.d.speicher.protokolliere(o, name, 'gesetzt', herkunft);
    this.d.protokoll?.('I4c Tresor gesetzt', { name, herkunft });
  }

  async erzeuge(o: string, name: string, laenge?: number, zweck?: string): Promise<void> {
    if ((await this.namen(o)).has(name)) throw new Error(`Tresor-Eintrag ${name} gibt es schon`);
    await this.setze(o, name, zufallsPasswort(laenge), 'erzeugt', zweck);
  }

  async entferne(o: string, name: string): Promise<boolean> {
    const ok = await this.d.speicher.entferne(o, name);
    if (ok) await this.d.speicher.protokolliere(o, name, 'entfernt');
    return ok;
  }

  /** Nur für den Ausführungsmotor: Wert lesen, Zugriff protokollieren. */
  async lies(o: string, name: string, wofuer: string): Promise<string> {
    const c = await this.d.speicher.roh(o, name);
    if (!c) throw new Error(`Tresor-Eintrag ${name} fehlt`);
    await this.d.speicher.protokolliere(o, name, 'gelesen', wofuer);
    this.d.protokoll?.('I4c Tresor gelesen', { name, wofuer });
    return entschluessele(await this.k(), c);
  }
}

/** Bekannte Geheimwerte aus einem Text entfernen (zweite Linie neben der Schwärzung). */
export function ohneGeheimnisse(text: string, werte: string[]): string {
  let t = text;
  for (const w of werte.filter(x => x.length >= 4).sort((a, b) => b.length - a.length)) t = t.split(w).join('***');
  return t;
}
